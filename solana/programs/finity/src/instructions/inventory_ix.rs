//! The pool's backstop inventory (F-4.5e, §8.6.1, §8.8). Tokens the pool bought at a clearing sit in its associated
//! token account and are carried in NAV at min(qty × (1 − κ) × V, cost).
//!  - Stocks are resold by a continuous GDA: k = 1.02 × V, the price halves every 24 h, the inventory is emitted
//!    over 3 days, and no unit sells below (1 − κ) × V. Buying is allowed in the regular session only.
//!  - T-Bill fund inventory is redeemed with the fund instead (the settlement adapter's fallback advance): the
//!    claim is carried at what the pool paid until the fund pays NAV a day later (T+1). On devnet the protocol's
//!    test fund is the issuer, so the payout is minted test USDC.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::{clock as clk, constants::*, error::FinityError, instructions::auction_ix::kappa_of, math::*, state::*};

/// Re-marks one inventory at `price` and moves the pool's aggregate mark by the difference.
pub fn remark(inv: &mut Inventory, pool: &mut UnderwriterPool, price: u64, dec: u8, kappa_wad: u128) -> Result<()> {
    let at_price = mul_div(mul_div(inv.qty as u128, price as u128, 10u128.pow(dec as u32))?, WAD - kappa_wad, WAD)?;
    let mark = to_u64(at_price.min(inv.cost as u128))?;
    pool.inventory_mark = pool.inventory_mark.saturating_sub(inv.mark).saturating_add(mark);
    inv.mark = mark;
    Ok(())
}

fn kappa(inv: &Inventory, cfg: &RiskConfig) -> u128 {
    kappa_of(KIND_INTRADAY, inv.nav, cfg)
}

fn pool_seeds(pool: &UnderwriterPool) -> ([u8; 8], [u8; 1]) {
    (pool.venue, [pool.bump])
}

// ---------- mark ----------

#[derive(Accounts)]
pub struct MarkInventory<'info> {
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [INVENTORY_SEED, pool.key().as_ref(), inventory.mint.as_ref()], bump = inventory.bump, has_one = pool, has_one = market)]
    pub inventory: Box<Account<'info, Inventory>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
}

/// Permissionless: re-marks an inventory at the market's current price (the keeper runs it with its price pushes).
pub fn handle_mark_inventory(mut ctx: Context<MarkInventory>) -> Result<()> {
    let a = &mut ctx.accounts;
    let k = kappa(&a.inventory, &a.risk_config);
    remark(&mut a.inventory, &mut a.pool, a.market.price, a.market.collateral_decimals, k)
}

// ---------- GDA resale ----------

#[derive(Accounts)]
pub struct ResellInventory<'info> {
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [INVENTORY_SEED, pool.key().as_ref(), inventory.mint.as_ref()], bump = inventory.bump, has_one = pool, has_one = market)]
    pub inventory: Box<Account<'info, Inventory>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
}

/// Permissionless, in the regular session: lists all of a stock inventory in a new GDA (F-4.5e).
pub fn handle_resell_inventory(mut ctx: Context<ResellInventory>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    require!(!a.inventory.nav, FinityError::NavInventory);
    require!(!a.inventory.gda.active, FinityError::GdaRunning);
    require!(a.inventory.qty > 0, FinityError::NoInventory);
    let state = clk::poke(&mut a.clock, a.calendar.load()?.live(), &mut a.market, now)?;
    require!(state == ClockState::Regular, FinityError::MarketNotOpen);
    let k = to_u64(mul_div(a.market.price as u128, GDA_START_MARKUP_BPS as u128, BPS as u128)?)?;
    let qty = a.inventory.qty;
    let inv = &mut a.inventory;
    inv.gda = Gda {
        active: true,
        qty,
        sold: 0,
        k,
        decay: GDA_DECAY_WAD,
        emission_per_sec: (qty / GDA_EMISSION_PERIOD as u64).max(1),
        start: now,
    };
    inv.gdas_started += 1;
    let kap = kappa(inv, &a.risk_config);
    remark(inv, &mut a.pool, a.market.price, a.market.collateral_decimals, kap)
}

/// Cost of the next `qty` units of a running GDA at `now`: the continuous price, floored at qty × (1 − κ) × V.
pub fn gda_price(g: &Gda, qty: u64, now: i64, price: u64, dec: u8, kappa_wad: u128) -> Result<u64> {
    let cont = gda_cost(g.k, g.decay, g.emission_per_sec, g.sold, qty, now - g.start, dec)?;
    let floor = to_u64(mul_div_up(mul_div_up(qty as u128, price as u128, 10u128.pow(dec as u32))?, WAD - kappa_wad, WAD)?)?;
    Ok(cont.max(floor))
}

#[derive(Accounts)]
pub struct GdaBuy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [INVENTORY_SEED, pool.key().as_ref(), inventory.mint.as_ref()], bump = inventory.bump, has_one = pool, has_one = market)]
    pub inventory: Box<Account<'info, Inventory>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = pool, associated_token::token_program = token_program)]
    pub pool_tokens: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = buyer,
        associated_token::mint = collateral_mint, associated_token::authority = buyer, associated_token::token_program = token_program,
    )]
    pub buyer_tokens: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Buys the next `qty` units of a GDA at `gda_price` (≤ `max_cost`), in the regular session only. The USDC goes to
/// the pool; the cost basis of the units sold leaves the inventory.
pub fn handle_gda_buy(mut ctx: Context<GdaBuy>, qty: u64, max_cost: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    let g = a.inventory.gda;
    require!(g.active, FinityError::GdaNotActive);
    require!(qty > 0 && qty <= g.qty - g.sold, FinityError::ZeroAmount);
    let state = clk::poke(&mut a.clock, a.calendar.load()?.live(), &mut a.market, now)?;
    require!(state == ClockState::Regular, FinityError::MarketNotOpen);
    let dec = a.market.collateral_decimals;
    let kap = kappa(&a.inventory, &a.risk_config);
    let cost = gda_price(&g, qty, now, a.market.price, dec, kap)?;
    require!(cost <= max_cost, FinityError::CostAboveMax);

    token::transfer(
        CpiContext::new(
            a.token_program.key(),
            Transfer { from: a.buyer_usdc.to_account_info(), to: a.usdc_vault.to_account_info(), authority: a.buyer.to_account_info() },
        ),
        cost,
    )?;
    let (venue, bump) = pool_seeds(&a.pool);
    let seeds: &[&[u8]] = &[POOL_SEED, &venue, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Transfer { from: a.pool_tokens.to_account_info(), to: a.buyer_tokens.to_account_info(), authority: a.pool.to_account_info() },
            &[seeds],
        ),
        qty,
    )?;

    let inv = &mut a.inventory;
    let basis = to_u64(mul_div(inv.cost as u128, qty as u128, inv.qty as u128)?)?;
    inv.qty -= qty;
    inv.cost -= basis;
    inv.gda.sold += qty;
    if inv.gda.sold == inv.gda.qty {
        inv.gda.active = false;
    }
    a.pool.cash += cost;
    remark(inv, &mut a.pool, a.market.price, dec, kap)
}

#[derive(Accounts)]
pub struct CloseGda<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [INVENTORY_SEED, pool.key().as_ref(), inventory.mint.as_ref()], bump = inventory.bump, has_one = pool, has_one = market)]
    pub inventory: Box<Account<'info, Inventory>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
}

/// Ends a GDA; the unsold units stay in the inventory (and can be listed again). The keeper or admin can end it any
/// time, anyone once it has run twice its emission period.
pub fn handle_close_gda(mut ctx: Context<CloseGda>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    require!(a.inventory.gda.active, FinityError::GdaNotActive);
    let s = a.signer.key();
    require!(
        s == a.config.admin || s == a.config.keeper || now >= a.inventory.gda.start + GDA_MAX_RUN,
        FinityError::GdaStillRunning
    );
    a.inventory.gda.active = false;
    let kap = kappa(&a.inventory, &a.risk_config);
    remark(&mut a.inventory, &mut a.pool, a.market.price, a.market.collateral_decimals, kap)
}

// ---------- T-Bill fund redemptions (§8.8) ----------

#[derive(Accounts)]
pub struct RequestRedemption<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [INVENTORY_SEED, pool.key().as_ref(), inventory.mint.as_ref()], bump = inventory.bump, has_one = pool, has_one = market)]
    pub inventory: Box<Account<'info, Inventory>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = pool, associated_token::token_program = token_program)]
    pub pool_tokens: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = cranker, space = 8 + Redemption::INIT_SPACE,
        seeds = [REDEMPTION_SEED, pool.key().as_ref(), &(pool.redemptions + 1).to_le_bytes()], bump,
    )]
    pub redemption: Box<Account<'info, Redemption>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: hands all of a T-Bill inventory to the fund for redemption (the tokens are burned by the fund)
/// and carries the claim in NAV at its cost until the fund pays (T+1).
pub fn handle_request_redemption(mut ctx: Context<RequestRedemption>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    require!(a.inventory.nav, FinityError::NotNavInventory);
    let qty = a.inventory.qty;
    require!(qty > 0, FinityError::NoInventory);
    let (venue, bump) = pool_seeds(&a.pool);
    let seeds: &[&[u8]] = &[POOL_SEED, &venue, &bump];
    token::burn(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Burn { mint: a.collateral_mint.to_account_info(), from: a.pool_tokens.to_account_info(), authority: a.pool.to_account_info() },
            &[seeds],
        ),
        qty,
    )?;
    let cost = a.inventory.cost;
    let inv = &mut a.inventory;
    inv.qty = 0;
    inv.cost = 0;
    remark(inv, &mut a.pool, a.market.price, a.market.collateral_decimals, 0)?;
    let pool = &mut a.pool;
    pool.redemptions += 1;
    pool.claims_cost += cost;
    let r = &mut a.redemption;
    r.pool = pool.key();
    r.market = a.market.key();
    r.id = pool.redemptions;
    r.qty = qty;
    r.cost = cost;
    r.requested_at = now;
    r.ready_at = now + REDEMPTION_DELAY;
    r.bump = ctx.bumps.redemption;
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRedemption<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [REDEMPTION_SEED, pool.key().as_ref(), &redemption.id.to_le_bytes()], bump = redemption.bump, has_one = pool, has_one = market)]
    pub redemption: Box<Account<'info, Redemption>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless once the fund fulfilled the redemption: the fund pays qty × NAV into the pool (on devnet the
/// protocol's test fund mints it). Realised P&L = assets − cost (mostly the κ_nav discount) lands in NAV.
pub fn handle_claim_redemption(mut ctx: Context<ClaimRedemption>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    let r = &a.redemption;
    require!(!r.claimed, FinityError::NothingToClaim);
    require!(now >= r.ready_at, FinityError::RedemptionNotReady);
    let assets = to_u64(mul_div(r.qty as u128, a.market.price as u128, 10u128.pow(a.market.collateral_decimals as u32))?)?;
    let seeds: &[&[u8]] = &[CONFIG_SEED, &[a.config.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            a.token_program.key(),
            MintTo { mint: a.usdc_mint.to_account_info(), to: a.usdc_vault.to_account_info(), authority: a.config.to_account_info() },
            &[seeds],
        ),
        assets,
    )?;
    let cost = r.cost;
    a.pool.claims_cost = a.pool.claims_cost.saturating_sub(cost);
    a.pool.cash += assets;
    let r = &mut a.redemption;
    r.claimed = true;
    r.assets = assets;
    Ok(())
}

// ---------- one-time migration ----------

#[derive(Accounts)]
pub struct MigratePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: an UnderwriterPool created before the inventory fields; owner and discriminator are checked below.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Admin, once per pool: grows a pool created before the inventory fields to the current size (the new fields
/// start at zero) and tops up its rent.
pub fn handle_migrate_pool(ctx: Context<MigratePool>) -> Result<()> {
    let ai = ctx.accounts.pool.to_account_info();
    require_keys_eq!(*ai.owner, crate::ID, FinityError::WrongPool);
    require!(ai.try_borrow_data()?[..8] == *UnderwriterPool::DISCRIMINATOR, FinityError::WrongPool);
    let new_len = 8 + UnderwriterPool::INIT_SPACE;
    require!(ai.data_len() < new_len, FinityError::AlreadyMigrated);
    let need = Rent::get()?.minimum_balance(new_len).saturating_sub(ai.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to: ai.clone() },
            ),
            need,
        )?;
    }
    ai.resize(new_len)?;
    Ok(())
}
