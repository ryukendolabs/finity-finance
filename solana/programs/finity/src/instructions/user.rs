use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

use crate::{clock, constants::*, error::FinityError, state::*};

/// Accrues `market` and credits the senior vault with its share of the interest.
pub fn accrue(market: &mut Market, senior: &mut SeniorVault) -> Result<()> {
    let senior_interest = market.accrue(Clock::get()?.unix_timestamp)?;
    senior.total_supplied = senior.total_supplied.checked_add(senior_interest).ok_or(FinityError::MathOverflow)?;
    Ok(())
}

/// Pokes the market's clock, then checks `debt` against the limit that applies now.
macro_rules! check_borrow_limit {
    ($a:expr, $collateral:expr, $debt:expr, $now:expr) => {{
        clock::poke(&mut $a.clock, $a.calendar.load()?.live(), &mut $a.market, $now)?;
        let sets = clock::RiskSets { overnight: &$a.risk_overnight, weekend: &$a.risk_weekend, holiday: &$a.risk_holiday };
        let covered = $a.policy.as_ref().map_or(false, |p| {
            p.market == $a.market.key() && p.owner == $a.position.owner && p.closure_id == $a.clock.closure_id + 1
        });
        let g = crate::instructions::oracle_ix::guardian_of(&$a.guardian_state)?;
        let max_ltv = g.max_ltv_eff($a.market.max_ltv_bps, $now);
        clock::check_limit(&$a.market, &$a.clock, &$a.risk_config, &sets, $collateral, $debt, covered, max_ltv, $now)
    }};
}

// ---------- deposit (collateral) ----------

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init_if_needed, payer = owner, space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = owner)]
    pub owner_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, FinityError::ZeroAmount);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_collateral.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;
    let position = &mut ctx.accounts.position;
    if position.owner == Pubkey::default() {
        position.owner = ctx.accounts.owner.key();
        position.market = ctx.accounts.market.key();
        position.bump = ctx.bumps.position;
    }
    position.collateral = position.collateral.checked_add(amount).ok_or(FinityError::MathOverflow)?;
    let market = &mut ctx.accounts.market;
    market.total_collateral = market.total_collateral.checked_add(amount).ok_or(FinityError::MathOverflow)?;
    Ok(())
}

// ---------- withdraw (collateral) ----------

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut, seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump = position.bump,
        has_one = owner, has_one = market,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[CLOSURE_OVERNIGHT]], bump = risk_overnight.bump)]
    pub risk_overnight: Box<Account<'info, RiskSet>>,
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[CLOSURE_WEEKEND]], bump = risk_weekend.bump)]
    pub risk_weekend: Box<Account<'info, RiskSet>>,
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[CLOSURE_HOLIDAY_WEEKEND]], bump = risk_holiday.bump)]
    pub risk_holiday: Box<Account<'info, RiskSet>>,
    /// Gap Cover for the upcoming closure, if bought: the loan keeps max LTV through the Bell window.
    pub policy: Option<Box<Account<'info, Policy>>>,
    /// CHECK: the guardian state PDA (may not exist yet); read by `guardian_of`.
    pub guardian_state: UncheckedAccount<'info>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = owner)]
    pub owner_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, FinityError::ZeroAmount);
    accrue(&mut ctx.accounts.market, &mut ctx.accounts.senior)?;
    let now = Clock::get()?.unix_timestamp;
    let remaining = ctx.accounts.position.collateral.checked_sub(amount).ok_or(FinityError::InsufficientCollateral)?;
    let debt = ctx.accounts.market.debt_of(ctx.accounts.position.borrow_shares)?;
    if debt > 0 {
        ctx.accounts.market.require_fresh_price(now)?;
        check_borrow_limit!(ctx.accounts, remaining, debt, now)?;
    }
    let market = &ctx.accounts.market;

    let mint_key = market.collateral_mint;
    let seeds: &[&[u8]] = &[MARKET_SEED, mint_key.as_ref(), &[market.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner_collateral.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    ctx.accounts.position.collateral = remaining;
    ctx.accounts.market.total_collateral -= amount;
    Ok(())
}

// ---------- borrow ----------

#[derive(Accounts)]
pub struct Borrow<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut, seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump = position.bump,
        has_one = owner, has_one = market,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[CLOSURE_OVERNIGHT]], bump = risk_overnight.bump)]
    pub risk_overnight: Box<Account<'info, RiskSet>>,
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[CLOSURE_WEEKEND]], bump = risk_weekend.bump)]
    pub risk_weekend: Box<Account<'info, RiskSet>>,
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[CLOSURE_HOLIDAY_WEEKEND]], bump = risk_holiday.bump)]
    pub risk_holiday: Box<Account<'info, RiskSet>>,
    /// Gap Cover for the upcoming closure, if bought: the loan keeps max LTV through the Bell window.
    pub policy: Option<Box<Account<'info, Policy>>>,
    /// CHECK: the guardian state PDA (may not exist yet); read by `guardian_of`.
    pub guardian_state: UncheckedAccount<'info>,
    pub usdc_mint: Box<Account<'info, Mint>>,
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

pub fn handle_borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
    require!(amount > 0, FinityError::ZeroAmount);
    accrue(&mut ctx.accounts.market, &mut ctx.accounts.senior)?;
    let now = Clock::get()?.unix_timestamp;
    require!(!crate::instructions::oracle_ix::guardian_of(&ctx.accounts.guardian_state)?.borrow_paused, FinityError::GuardianBorrowPaused);
    let market = &ctx.accounts.market;
    market.require_fresh_price(now)?;
    require!(amount <= market.liquidity(), FinityError::InsufficientLiquidity);
    require!(
        market.total_borrow_assets.checked_add(amount).ok_or(FinityError::MathOverflow)? <= market.borrow_cap,
        FinityError::BorrowCapExceeded
    );
    let new_debt = market.debt_of(ctx.accounts.position.borrow_shares)?.checked_add(amount).ok_or(FinityError::MathOverflow)?;
    let collateral = ctx.accounts.position.collateral;
    check_borrow_limit!(ctx.accounts, collateral, new_debt, now)?;

    let shares = ctx.accounts.market.add_borrow(amount)?;
    ctx.accounts.position.borrow_shares += shares;
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
        amount,
    )
}

// ---------- repay ----------

#[derive(Accounts)]
pub struct Repay<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut, seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump = position.bump,
        has_one = owner, has_one = market,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Repays up to `amount`; anything above the outstanding debt (interest included) is not taken.
pub fn handle_repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
    require!(amount > 0, FinityError::ZeroAmount);
    accrue(&mut ctx.accounts.market, &mut ctx.accounts.senior)?;
    let held = ctx.accounts.position.borrow_shares;
    let debt = ctx.accounts.market.debt_of(held)?;
    require!(held > 0 && debt > 0, FinityError::NoDebt);
    let pay = amount.min(debt);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_usdc.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        pay,
    )?;
    let burned = ctx.accounts.market.remove_borrow(pay, held)?;
    ctx.accounts.position.borrow_shares = held - burned;
    Ok(())
}
