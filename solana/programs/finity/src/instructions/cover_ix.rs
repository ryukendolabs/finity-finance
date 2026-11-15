//! Gap Cover and the Bell (F-4.3, F-4.4).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    clock as clk,
    constants::*,
    error::FinityError,
    instructions::{pool_ix::{joint_gaps, refresh_bounds}, user::accrue},
    math::*,
    risk,
    state::*,
};

#[derive(Accounts)]
pub struct WriteCover<'info> {
    /// The borrower buying cover, or anyone enforcing the Bell (pays the policy account's rent).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()], bump = position.bump, has_one = market)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    /// The risk set of the upcoming closure's type.
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[risk_set.closure_type]], bump = risk_set.bump, has_one = market)]
    pub risk_set: Box<Account<'info, RiskSet>>,
    #[account(seeds = [JOINT_SEED, market.key().as_ref()], bump = joint.bump, has_one = market)]
    pub joint: Box<Account<'info, JointColumn>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [EPOCH_SEED, pool.key().as_ref(), &pool.epochs_opened.to_le_bytes()], bump)]
    pub epoch: AccountLoader<'info, Epoch>,
    #[account(mut, seeds = [EPOCH_MARKET_SEED, epoch.key().as_ref(), market.key().as_ref()], bump)]
    pub epoch_market: AccountLoader<'info, EpochMarket>,
    /// One policy per loan per closure: a second purchase fails here.
    #[account(
        init, payer = payer, space = 8 + Policy::INIT_SPACE,
        seeds = [POLICY_SEED, market.key().as_ref(), position.owner.as_ref(), &(clock.closure_id + 1).to_le_bytes()], bump,
    )]
    pub policy: Box<Account<'info, Policy>>,
    /// CHECK: the guardian state PDA (may not exist yet); read by `guardian_of`.
    pub guardian_state: UncheckedAccount<'info>,
    /// CHECK: the loan's auto-cover opt-out marker PDA (address checked in the handler); only its existence is read.
    pub opt_out: UncheckedAccount<'info>,
    /// The borrower's USDC, when the premium is paid in cash.
    #[account(mut, token::mint = config.usdc_mint)]
    pub owner_usdc: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Coverable LTV (R-03): max LTV + 0.5 pp, never above the liquidation threshold − 2 pp. WAD.
pub fn coverable_ltv(m: &Market) -> u128 {
    coverable_ltv_at(m, m.max_ltv_bps)
}

/// `coverable_ltv` with the effective (haircut) max LTV.
pub fn coverable_ltv_at(m: &Market, max_ltv_bps: u16) -> u128 {
    let a = max_ltv_bps as u128 + DELTA_COVER_BPS as u128;
    let b = (m.liq_threshold_bps as u128).saturating_sub(COVER_LT_GAP_BPS as u128);
    a.min(b) * WAD / BPS as u128
}

/// `auto = false`: the borrower buys cover for the upcoming closure, in the regular session before the Bell
/// deadline, paying `max_premium` at most, in cash or added to debt.
/// `auto = true`: the Bell. Between the deadline and the close anyone may cover a loan that needs action at the
/// closure's safe LTV, premium added to its debt (a loan above the coverable LTV needs the pre-close sale instead).
pub fn handle_write_cover(mut ctx: Context<WriteCover>, max_premium: u64, add_to_debt: bool, auto: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    let state = clk::poke(&mut a.clock, a.calendar.load()?.live(), &mut a.market, now)?;
    require!(state == ClockState::Regular && a.clock.bell_at > 0, FinityError::CoverWindowClosed);
    if auto {
        require!(now >= a.clock.bell_at && now < a.clock.next_close_at, FinityError::CoverWindowClosed);
        let (marker, _) = Pubkey::find_program_address(&[NO_AUTOCOVER_SEED, a.position.key().as_ref()], &crate::ID);
        require_keys_eq!(a.opt_out.key(), marker, FinityError::AutoCoverOff);
        require!(a.opt_out.data_is_empty(), FinityError::AutoCoverOff);
    } else {
        require_keys_eq!(a.payer.key(), a.position.owner, FinityError::NotAdmin);
        require!(now < a.clock.bell_at, FinityError::CoverWindowClosed);
    }
    let add_to_debt = add_to_debt || auto;
    let g = crate::instructions::oracle_ix::guardian_of(&a.guardian_state)?;
    require!(!g.cover_paused, FinityError::GuardianCoverPaused);
    let max_ltv = g.max_ltv_eff(a.market.max_ltv_bps, now);
    require!(a.risk_set.closure_type == a.clock.next_closure_type, FinityError::WrongRiskSet);

    accrue(&mut a.market, &mut a.senior)?;
    let market = &a.market;
    let debt = market.debt_of(a.position.borrow_shares)?;
    require!(debt > 0, FinityError::NoDebt);
    let c = market.collateral_value(a.position.collateral)?;
    let days = clk::closure_days(a.clock.next_close_at, a.clock.next_reopen_at)?;
    let d_proj = risk::projected_debt(debt as u128, market.borrow_rate()?, days)?;
    let ltv = risk::ltv_up(debt as u128, c)?;
    require!(ltv <= coverable_ltv_at(market, max_ltv), FinityError::LtvAboveCoverable);
    let cfg = &a.risk_config;
    let set = &a.risk_set;
    if auto {
        let safe = clk::safe_ltv_wad(market, cfg, set)?;
        let (status, _, _) = risk::bell_status(c, d_proj, safe, false)?;
        require!(status == risk::BELL_NEEDS_ACTION, FinityError::BellNotNeeded);
    }

    // Capacity (F-4.4) over the K joint scenarios: existing policies + this one + every market's uncovered bound.
    let (premium, adds) = {
        let mut e = a.epoch.load_mut()?;
        require!(e.phase == EPOCH_OPEN || e.phase == EPOCH_SNAPSHOT, FinityError::NoOpenEpoch);
        require!(e.close_at == a.clock.next_close_at, FinityError::NoOpenEpoch);
        let mut em = a.epoch_market.load_mut()?;
        em.covered_collateral += a.position.collateral;
        // g(z_j) once for the K joint scenarios, shared by the uncovered bound and the policy's loss.
        let gs = joint_gaps(&a.joint, cfg, set)?;
        refresh_bounds(&mut e, &mut em, market, cfg, set, &gs)?;
        em.refreshed_at = now;

        let (sigma, div, kappa) = (set.sigma as u128, set.dividend as u128, cfg.kappa as u128);
        let mut adds = vec![0u64; K_STRESS]; // heap: 2 KB would overflow the 4 KB stack frame
        let mut worst = 0u128;
        for j in 0..K_STRESS {
            adds[j] = risk::policy_loss_g(gs[j], c, d_proj)?;
            let lambda = e.policy_losses[j] as u128 + adds[j] as u128 + e.uncovered[j] as u128;
            worst = worst.max(lambda);
        }
        let equity = if e.phase == EPOCH_SNAPSHOT { e.equity_at_risk } else { a.pool.nav() };
        let util = risk::utilisation(worst, equity as u128)?;
        require!(util <= cfg.u_max as u128, FinityError::PoolCapacityExceeded);

        let q = risk::quote_cover(
            &set.z_tail,
            set.n,
            &risk::PremiumParams {
                sigma,
                dividend: div,
                kappa,
                collateral_value: c,
                debt_projected: d_proj,
                closure_days: days,
                util_after: util,
                theta: cfg.theta as u128,
                cost_of_cap: cfg.cost_of_cap as u128,
                eta: cfg.eta as u128,
                beta: cfg.beta as u128,
                min_premium: cfg.min_premium as u128,
            },
        )?;
        (to_u64(q.premium)?, adds)
    };
    require!(auto || premium <= max_premium, FinityError::PremiumAboveMax);

    // Pay the premium to the pool: borrowed from the market (added to debt) or in cash.
    if add_to_debt {
        let m = &mut a.market;
        require!(premium <= m.liquidity(), FinityError::InsufficientLiquidity);
        require!(m.total_borrow_assets.saturating_add(premium) <= m.borrow_cap, FinityError::BorrowCapExceeded);
        let shares = m.add_borrow(premium)?;
        a.position.borrow_shares += shares;
    } else {
        let from = a.owner_usdc.as_ref().ok_or(FinityError::ZeroAmount)?;
        token::transfer(
            CpiContext::new(
                a.token_program.key(),
                Transfer { from: from.to_account_info(), to: a.usdc_vault.to_account_info(), authority: a.payer.to_account_info() },
            ),
            premium,
        )?;
    }
    a.pool.cash += premium;
    a.pool.unearned_premiums += premium;
    let seq = {
        let mut e = a.epoch.load_mut()?;
        e.premiums += premium;
        e.policies += 1;
        for j in 0..K_STRESS {
            e.policy_losses[j] = e.policy_losses[j].saturating_add(adds[j]);
        }
        e.seq
    };

    let p = &mut a.policy;
    p.market = a.market.key();
    p.owner = a.position.owner;
    p.closure_id = a.clock.closure_id + 1;
    p.epoch_seq = seq;
    p.premium = premium;
    p.collateral = a.position.collateral;
    p.debt_projected = to_u64(d_proj)?;
    p.auto = auto;
    p.bump = ctx.bumps.policy;
    Ok(())
}

// ---------- auto-cover switch (per loan) ----------

#[derive(Accounts)]
pub struct SetAutoCover<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner, has_one = market)]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the opt-out marker PDA, created (off) or closed (on) here.
    #[account(mut, seeds = [NO_AUTOCOVER_SEED, position.key().as_ref()], bump)]
    pub opt_out: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// On (default): at the Bell, a loan above its safe LTV is auto-covered, premium added to debt. Off: it is sold
/// down to the safe LTV in the pre-close batch instead (1% penalty).
pub fn handle_set_auto_cover(ctx: Context<SetAutoCover>, enabled: bool) -> Result<()> {
    let a = &ctx.accounts;
    let marker = a.opt_out.to_account_info();
    if enabled {
        if !marker.data_is_empty() {
            // Close: rent back to the owner, data cleared.
            let lamports = marker.lamports();
            **marker.try_borrow_mut_lamports()? -= lamports;
            **a.owner.to_account_info().try_borrow_mut_lamports()? += lamports;
            marker.assign(&anchor_lang::solana_program::system_program::ID);
            marker.resize(0)?;
        }
        return Ok(());
    }
    if marker.data_is_empty() {
        let space = 8 + AutoCoverOptOut::INIT_SPACE;
        let rent = Rent::get()?.minimum_balance(space);
        let pos = a.position.key();
        let seeds: &[&[u8]] = &[NO_AUTOCOVER_SEED, pos.as_ref(), &[ctx.bumps.opt_out]];
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                anchor_lang::system_program::ID,
                anchor_lang::system_program::CreateAccount { from: a.owner.to_account_info(), to: marker.clone() },
                &[seeds],
            ),
            rent,
            space as u64,
            &crate::ID,
        )?;
        let data = AutoCoverOptOut { position: pos, bump: ctx.bumps.opt_out };
        let mut buf = marker.try_borrow_mut_data()?;
        data.try_serialize(&mut &mut buf[..])?;
    }
    Ok(())
}
