//! Senior lenders: deposit USDC for shares, redeem now from available liquidity, or queue a
//! redeem request that is paid FIFO at the share price when processed, then claimed.
//! Every instruction that prices shares takes all vault markets as remaining accounts, in vault order.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::{constants::*, error::FinityError, state::*, vault_markets};

// ---------- lend_deposit ----------

#[derive(Accounts)]
pub struct LendDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump, has_one = share_mint)]
    pub senior: Box<Account<'info, SeniorVault>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = owner,
        associated_token::mint = share_mint, associated_token::authority = owner, associated_token::token_program = token_program,
    )]
    pub owner_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [DEAD_SHARES_SEED], bump = senior.dead_bump)]
    pub dead_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_lend_deposit<'info>(ctx: Context<'info, LendDeposit<'info>>, assets: u64) -> Result<()> {
    require!(assets > 0, FinityError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let senior = &mut ctx.accounts.senior;
    let mut markets = vault_markets::load(senior, ctx.remaining_accounts, now)?;

    let supply = ctx.accounts.share_mint.supply;
    let mut shares = senior.to_shares(assets, supply)?;
    let first = supply == 0;
    if first {
        require!(shares > DEAD_SHARES, FinityError::ZeroShares);
        shares -= DEAD_SHARES;
    }
    require!(shares > 0, FinityError::ZeroShares);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_usdc.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        assets,
    )?;
    senior.idle = senior.idle.checked_add(assets).ok_or(FinityError::MathOverflow)?;
    vault_markets::supply_down(senior, &mut markets, assets);
    vault_markets::save(&markets)?;

    let bump = senior.bump;
    let seeds: &[&[u8]] = &[SENIOR_SEED, &[bump]];
    let mint = |to: AccountInfo<'info>, amount: u64| {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo { mint: ctx.accounts.share_mint.to_account_info(), to, authority: ctx.accounts.senior.to_account_info() },
                &[seeds],
            ),
            amount,
        )
    };
    if first {
        mint(ctx.accounts.dead_shares.to_account_info(), DEAD_SHARES)?;
    }
    mint(ctx.accounts.owner_shares.to_account_info(), shares)
}

// ---------- lend_redeem (instant) ----------

#[derive(Accounts)]
pub struct LendRedeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump, has_one = share_mint)]
    pub senior: Box<Account<'info, SeniorVault>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub owner_shares: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = owner,
        associated_token::mint = usdc_mint, associated_token::authority = owner, associated_token::token_program = token_program,
    )]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_lend_redeem<'info>(ctx: Context<'info, LendRedeem<'info>>, shares: u64) -> Result<()> {
    require!(shares > 0, FinityError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let senior = &mut ctx.accounts.senior;
    let mut markets = vault_markets::load(senior, ctx.remaining_accounts, now)?;

    let assets = senior.to_assets(shares, ctx.accounts.share_mint.supply)?;
    require!(assets > 0, FinityError::ZeroAmount);
    require!(assets <= vault_markets::available(senior, &markets), FinityError::VaultIlliquid);
    vault_markets::pull(senior, &mut markets, assets)?;
    senior.idle -= assets;
    vault_markets::save(&markets)?;

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.owner_shares.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        shares,
    )?;
    let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.owner_usdc.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ),
        assets,
    )
}

// ---------- request_redeem ----------

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump, has_one = share_mint)]
    pub senior: Box<Account<'info, SeniorVault>>,
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub owner_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SHARE_ESCROW_SEED], bump = senior.escrow_bump)]
    pub share_escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = owner, space = 8 + RedeemRequest::INIT_SPACE,
        seeds = [REDEEM_SEED, &senior.next_request_id.to_le_bytes()], bump,
    )]
    pub request: Box<Account<'info, RedeemRequest>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Escrows `shares` and joins the FIFO queue; they keep earning until processed (still in the share supply).
pub fn handle_request_redeem(ctx: Context<RequestRedeem>, shares: u64) -> Result<()> {
    require!(shares > 0, FinityError::ZeroAmount);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_shares.to_account_info(),
                to: ctx.accounts.share_escrow.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        shares,
    )?;
    let senior = &mut ctx.accounts.senior;
    let r = &mut ctx.accounts.request;
    r.id = senior.next_request_id;
    r.owner = ctx.accounts.owner.key();
    r.shares = shares;
    r.created_at = Clock::get()?.unix_timestamp;
    r.bump = ctx.bumps.request;
    senior.next_request_id += 1;
    senior.pending_redeem_shares += shares;
    Ok(())
}

// ---------- process_redeem_queue (permissionless) ----------

#[derive(Accounts)]
pub struct ProcessRedeemQueue<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump, has_one = share_mint)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [SHARE_ESCROW_SEED], bump = senior.escrow_bump)]
    pub share_escrow: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Remaining accounts: every vault market (vault order), then redeem requests from `queue_head` on, in order.
/// Pays each at the current share price while liquidity lasts (processQueue).
pub fn handle_process_redeem_queue<'info>(ctx: Context<'info, ProcessRedeemQueue<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let senior = &mut ctx.accounts.senior;
    let n = senior.markets.len();
    let mut markets = vault_markets::load(senior, ctx.remaining_accounts, now)?;
    let mut supply = ctx.accounts.share_mint.supply;
    let mut burned = 0u64;

    for ai in &ctx.remaining_accounts[n..] {
        if senior.queue_head >= senior.next_request_id {
            break;
        }
        let (expected, _) = Pubkey::find_program_address(&[REDEEM_SEED, &senior.queue_head.to_le_bytes()], &crate::ID);
        require_keys_eq!(*ai.key, expected, FinityError::WrongRedeemRequest);
        let mut r = Account::<RedeemRequest>::try_from(ai)?;
        let assets = senior.to_assets(r.shares, supply)?;
        if assets > vault_markets::available(senior, &markets) {
            break;
        }
        vault_markets::pull(senior, &mut markets, assets)?;
        senior.idle -= assets;
        senior.claimable_assets += assets;
        senior.pending_redeem_shares -= r.shares;
        supply -= r.shares;
        burned += r.shares;
        r.assets = assets;
        r.processed = true;
        r.exit(&crate::ID)?;
        senior.queue_head += 1;
    }
    vault_markets::save(&markets)?;

    if burned > 0 {
        let bump = senior.bump;
        let seeds: [&[u8]; 2] = [SENIOR_SEED, &[bump]];
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.share_escrow.to_account_info(),
                    authority: ctx.accounts.senior.to_account_info(),
                },
                &[&seeds],
            ),
            burned,
        )?;
    }
    Ok(())
}

// ---------- claim_redeem ----------

#[derive(Accounts)]
pub struct ClaimRedeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, has_one = owner, close = owner, seeds = [REDEEM_SEED, &request.id.to_le_bytes()], bump = request.bump)]
    pub request: Box<Account<'info, RedeemRequest>>,
    #[account(
        init_if_needed, payer = owner,
        associated_token::mint = usdc_mint, associated_token::authority = owner, associated_token::token_program = token_program,
    )]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Pays out a processed request and closes it (rent back to the owner).
pub fn handle_claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
    let r = &ctx.accounts.request;
    require!(r.processed, FinityError::RequestNotProcessed);
    require!(!r.claimed, FinityError::RequestAlreadyClaimed);
    let assets = r.assets;
    ctx.accounts.senior.claimable_assets -= assets;
    let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.owner_usdc.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ),
        assets,
    )
}
