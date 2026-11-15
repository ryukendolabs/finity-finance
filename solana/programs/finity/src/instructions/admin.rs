use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount},
};

use crate::{constants::*, error::FinityError, state::*};

// ---------- initialize ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(constraint = usdc_mint.decimals == USDC_DECIMALS @ FinityError::InvalidRiskParams)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init, payer = admin, seeds = [USDC_VAULT_SEED], bump,
        token::mint = usdc_mint, token::authority = config, token::token_program = token_program,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, space = 8 + SeniorVault::INIT_SPACE, seeds = [SENIOR_SEED], bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(
        init, payer = admin, seeds = [SHARE_MINT_SEED], bump,
        mint::decimals = SHARE_DECIMALS, mint::authority = senior, mint::token_program = token_program,
    )]
    pub share_mint: Box<Account<'info, Mint>>,
    /// Holds the shares of queued redeem requests.
    #[account(
        init, payer = admin, seeds = [SHARE_ESCROW_SEED], bump,
        token::mint = share_mint, token::authority = senior, token::token_program = token_program,
    )]
    pub share_escrow: Box<Account<'info, TokenAccount>>,
    /// Receives the 1e3 dead shares of the first deposit; nothing can move them out.
    #[account(
        init, payer = admin, seeds = [DEAD_SHARES_SEED], bump,
        token::mint = share_mint, token::authority = senior, token::token_program = token_program,
    )]
    pub dead_shares: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, keeper: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.keeper = keeper;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.bump = ctx.bumps.config;
    config.usdc_vault_bump = ctx.bumps.usdc_vault;

    let senior = &mut ctx.accounts.senior;
    senior.share_mint = ctx.accounts.share_mint.key();
    senior.allocator = ctx.accounts.admin.key();
    senior.queue_head = 1;
    senior.next_request_id = 1;
    senior.bump = ctx.bumps.senior;
    senior.share_mint_bump = ctx.bumps.share_mint;
    senior.escrow_bump = ctx.bumps.share_escrow;
    senior.dead_bump = ctx.bumps.dead_shares;
    Ok(())
}

// ---------- init_market ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitMarketParams {
    pub symbol: String,
    pub price: u64,
    pub max_ltv_bps: u16,
    pub closed_ltv_bps: u16,
    pub liq_threshold_bps: u16,
    pub liq_bonus_bps: u16,
    pub rate: RateParams,
    pub supply_cap: u64,
    pub borrow_cap: u64,
    /// How much the senior vault may supply to this market.
    pub vault_cap: u64,
}

#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(
        init, payer = admin, space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, collateral_mint.key().as_ref()], bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init, payer = admin, seeds = [VAULT_SEED, market.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = market, token::token_program = token_program,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_market(ctx: Context<InitMarket>, p: InitMarketParams) -> Result<()> {
    require!(!p.symbol.is_empty() && p.symbol.len() <= 8, FinityError::InvalidSymbol);
    require!(p.price > 0, FinityError::InvalidPrice);
    Market::validate_params(p.max_ltv_bps, p.closed_ltv_bps, p.liq_threshold_bps, p.liq_bonus_bps)?;
    Market::validate_rate(&p.rate)?;
    let senior = &mut ctx.accounts.senior;
    require!(senior.markets.len() < MAX_VAULT_MARKETS, FinityError::TooManyMarkets);

    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.symbol = p.symbol;
    market.collateral_decimals = ctx.accounts.collateral_mint.decimals;
    market.price = p.price;
    market.price_updated_at = now;
    market.session = Session::Closed;
    market.max_ltv_bps = p.max_ltv_bps;
    market.closed_ltv_bps = p.closed_ltv_bps;
    market.liq_threshold_bps = p.liq_threshold_bps;
    market.liq_bonus_bps = p.liq_bonus_bps;
    market.last_accrual = now;
    market.fee_pool_bps = DEFAULT_FEE_POOL_BPS;
    market.fee_treasury_bps = DEFAULT_FEE_TREASURY_BPS;
    market.rate = p.rate;
    market.supply_cap = p.supply_cap;
    market.borrow_cap = p.borrow_cap;
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.vault;

    let idx = senior.markets.len() as u8;
    senior.markets.push(market.key());
    senior.caps.push(p.vault_cap);
    senior.supply_queue.push(idx);
    senior.withdraw_queue.push(idx);
    Ok(())
}

// ---------- admin_mint (devnet) ----------

#[derive(Accounts)]
pub struct AdminMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED], bump = config.bump,
        has_one = admin @ FinityError::NotAdmin, has_one = usdc_mint,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed, payer = admin,
        associated_token::mint = usdc_mint, associated_token::authority = admin, associated_token::token_program = token_program,
    )]
    pub admin_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Mints test USDC to the admin, without the faucet cap, to seed the senior vault. Devnet only.
pub fn handle_admin_mint(ctx: Context<AdminMint>, amount: u64) -> Result<()> {
    require!(amount > 0, FinityError::ZeroAmount);
    let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.admin_usdc.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

// ---------- set_price (keeper) ----------

#[derive(Accounts)]
pub struct KeeperUpdate<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED], bump = config.bump,
        constraint = authority.key() == config.keeper || authority.key() == config.admin @ FinityError::NotKeeper,
    )]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: the oracle config PDA (may not exist yet); read by `keeper_price_allowed`.
    pub oracle: UncheckedAccount<'info>,
}

pub fn handle_set_price(ctx: Context<KeeperUpdate>, price: u64) -> Result<()> {
    require!(crate::instructions::oracle_ix::keeper_price_allowed(&ctx.accounts.oracle)?, FinityError::KeeperPriceDisabled);
    require!(price > 0, FinityError::InvalidPrice);
    let market = &mut ctx.accounts.market;
    market.price = price;
    market.price_updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}

// ---------- vault allocation (allocator) ----------

#[derive(Accounts)]
pub struct Allocate<'info> {
    pub allocator: Signer<'info>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump, has_one = allocator @ FinityError::NotAllocator)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
}

fn market_index(senior: &SeniorVault, market: &Pubkey) -> Result<usize> {
    senior.markets.iter().position(|k| k == market).ok_or_else(|| error!(FinityError::WrongMarketAccounts))
}

/// Moves idle vault cash into a market's supply, up to the vault cap and the market's supply cap.
pub fn handle_allocate(ctx: Context<Allocate>, assets: u64) -> Result<()> {
    let senior = &mut ctx.accounts.senior;
    let market = &mut ctx.accounts.market;
    let i = market_index(senior, &market.key())?;
    senior.total_supplied += market.accrue(Clock::get()?.unix_timestamp)?;
    let after = market.total_supply_assets.checked_add(assets).ok_or(FinityError::MathOverflow)?;
    require!(after <= senior.caps[i] && after <= market.supply_cap, FinityError::SupplyCapExceeded);
    require!(assets <= senior.idle, FinityError::InsufficientLiquidity);
    market.total_supply_assets = after;
    senior.idle -= assets;
    senior.total_supplied += assets;
    Ok(())
}

/// Moves a market's unborrowed supply back to idle vault cash.
pub fn handle_deallocate(ctx: Context<Allocate>, assets: u64) -> Result<()> {
    let senior = &mut ctx.accounts.senior;
    let market = &mut ctx.accounts.market;
    market_index(senior, &market.key())?;
    senior.total_supplied += market.accrue(Clock::get()?.unix_timestamp)?;
    require!(assets <= market.liquidity().min(market.total_supply_assets), FinityError::InsufficientLiquidity);
    market.total_supply_assets -= assets;
    senior.total_supplied -= assets;
    senior.idle += assets;
    Ok(())
}

#[derive(Accounts)]
pub struct SetVaultConfig<'info> {
    pub allocator: Signer<'info>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump, has_one = allocator @ FinityError::NotAllocator)]
    pub senior: Box<Account<'info, SeniorVault>>,
}

fn check_queue(q: &[u8], n: usize) -> Result<()> {
    for (i, &x) in q.iter().enumerate() {
        require!((x as usize) < n && !q[..i].contains(&x), FinityError::InvalidQueue);
    }
    Ok(())
}

pub fn handle_set_queues(ctx: Context<SetVaultConfig>, supply_queue: Vec<u8>, withdraw_queue: Vec<u8>) -> Result<()> {
    let senior = &mut ctx.accounts.senior;
    let n = senior.markets.len();
    check_queue(&supply_queue, n)?;
    check_queue(&withdraw_queue, n)?;
    // Every market can still be withdrawn from, so no supply is ever stranded (setWithdrawQueue).
    require!(withdraw_queue.len() == n, FinityError::InvalidQueue);
    senior.supply_queue = supply_queue;
    senior.withdraw_queue = withdraw_queue;
    Ok(())
}

pub fn handle_set_vault_cap(ctx: Context<SetVaultConfig>, index: u8, cap: u64) -> Result<()> {
    let senior = &mut ctx.accounts.senior;
    require!((index as usize) < senior.markets.len(), FinityError::InvalidQueue);
    senior.caps[index as usize] = cap;
    Ok(())
}
