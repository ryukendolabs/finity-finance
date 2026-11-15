//! Market clock and risk-engine administration: calendars (CalendarStore), per-market clocks (AssetClock),
//! guardian restrictions, risk parameters, scenario sets and σ (RiskEngine + SigmaOracle).

use anchor_lang::prelude::*;

use crate::{clock, constants::*, error::FinityError, risk, state::*};

// ---------- calendars ----------

#[derive(Accounts)]
#[instruction(venue: [u8; 8])]
pub struct InitCalendar<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + std::mem::size_of::<Calendar>(), seeds = [CALENDAR_SEED, &venue], bump)]
    pub calendar: AccountLoader<'info, Calendar>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_calendar(ctx: Context<InitCalendar>, venue: [u8; 8]) -> Result<()> {
    let mut c = ctx.accounts.calendar.load_init()?;
    c.venue = venue;
    c.bump = ctx.bumps.calendar;
    Ok(())
}

#[derive(Accounts)]
pub struct AppendSessions<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    /// Owner and type are checked by the loader; only the admin can append.
    #[account(mut)]
    pub calendar: AccountLoader<'info, Calendar>,
}

/// Appends sessions (CalendarStore.appendSessions): each must satisfy extOpen < open < close < extClose, follow
/// the previous one without overlap, and end in a scheduled closure type.
pub fn handle_append_sessions(ctx: Context<AppendSessions>, sessions: Vec<SessionArg>) -> Result<()> {
    let mut cal = ctx.accounts.calendar.load_mut()?;
    require!(!sessions.is_empty(), FinityError::InvalidSessions);
    let from = cal.len as usize;
    require!(from + sessions.len() <= MAX_SESSIONS, FinityError::CalendarFull);
    let mut prev_ext_close = if from == 0 { 0 } else { cal.sessions[from - 1].ext_close };
    for s in &sessions {
        require!(
            s.ext_open < s.open && s.open < s.close && s.close < s.ext_close && s.ext_open >= prev_ext_close,
            FinityError::InvalidSessions
        );
        require!(
            matches!(s.closure_type_after, CLOSURE_OVERNIGHT | CLOSURE_WEEKEND | CLOSURE_HOLIDAY_WEEKEND),
            FinityError::InvalidSessions
        );
        prev_ext_close = s.ext_close;
    }
    for (i, s) in sessions.iter().enumerate() {
        cal.sessions[from + i] = SessionRec {
            ext_open: s.ext_open,
            open: s.open,
            close: s.close,
            ext_close: s.ext_close,
            closure_type_after: s.closure_type_after,
            _pad: [0; 3],
        };
    }
    cal.len = (from + sessions.len()) as u32;
    Ok(())
}

// ---------- clocks ----------

#[derive(Accounts)]
pub struct InitClock<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(init, payer = admin, space = 8 + AssetClock::INIT_SPACE, seeds = [CLOCK_SEED, market.key().as_ref()], bump)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_clock(ctx: Context<InitClock>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &mut ctx.accounts.clock;
    c.market = ctx.accounts.market.key();
    c.calendar = ctx.accounts.calendar.key();
    c.restriction = ClockState::Regular;
    c.bump = ctx.bumps.clock;
    let cal = ctx.accounts.calendar.load()?;
    clock::init(c, cal.live(), now);
    clock::poke(c, cal.live(), &mut ctx.accounts.market, now)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Poke<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
}

/// Permissionless: advances the market's clock to now.
pub fn handle_poke(ctx: Context<Poke>) -> Result<()> {
    clock::poke(&mut ctx.accounts.clock, ctx.accounts.calendar.load()?.live(), &mut ctx.accounts.market, Clock::get()?.unix_timestamp)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Guardian<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED], bump = config.bump,
        constraint = authority.key() == config.keeper || authority.key() == config.admin @ FinityError::NotKeeper,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
}

/// Guardian restriction (IAssetClock.restrict): Closed or Halted, at most 7 days, never shortening an active one.
pub fn handle_restrict(ctx: Context<Guardian>, state: ClockState, until: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &mut ctx.accounts.clock;
    require!(
        matches!(state, ClockState::Closed | ClockState::Halted)
            && until > now
            && until <= now + MAX_RESTRICT_SECS
            && (c.restriction_until <= now || until >= c.restriction_until),
        FinityError::InvalidRestriction
    );
    c.restriction = more_or(state, c.restriction, c.restriction_until > now);
    c.restriction_until = until;
    clock::poke(c, ctx.accounts.calendar.load()?.live(), &mut ctx.accounts.market, now)?;
    Ok(())
}

fn more_or(new: ClockState, old: ClockState, old_active: bool) -> ClockState {
    if old_active && old.rank() > new.rank() {
        old
    } else {
        new
    }
}

/// Begins or ends a corporate action (split, merger, …): borrowing pauses and the market is treated as closed.
pub fn handle_set_corporate_action(ctx: Context<Guardian>, active: bool) -> Result<()> {
    require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.config.admin, FinityError::NotAdmin);
    ctx.accounts.clock.corporate_action = active;
    clock::poke(&mut ctx.accounts.clock, ctx.accounts.calendar.load()?.live(), &mut ctx.accounts.market, Clock::get()?.unix_timestamp)?;
    Ok(())
}

// ---------- risk engine ----------

#[derive(Accounts)]
pub struct SetRiskConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init_if_needed, payer = admin, space = 8 + RiskConfig::INIT_SPACE, seeds = [RISK_CONFIG_SEED], bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_risk_config(ctx: Context<SetRiskConfig>, p: RiskConfigParams, sigma_oracle: Pubkey) -> Result<()> {
    use crate::math::WAD;
    let w = WAD as u64;
    require!(
        p.alpha > 0 && p.alpha <= w && p.beta <= w && p.kappa <= w && p.u_max <= w,
        FinityError::InvalidRiskParams
    );
    let r = &mut ctx.accounts.risk_config;
    r.sigma_oracle = sigma_oracle;
    r.alpha = p.alpha;
    r.beta = p.beta;
    r.kappa = p.kappa;
    r.theta = p.theta;
    r.cost_of_cap = p.cost_of_cap;
    r.eta = p.eta;
    r.min_premium = p.min_premium;
    r.u_max = p.u_max;
    r.k_stress = p.k_stress;
    r.bump = ctx.bumps.risk_config;
    Ok(())
}

#[derive(Accounts)]
#[instruction(closure_type: u8)]
pub struct SetScenarioSet<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init_if_needed, payer = admin, space = 8 + RiskSet::INIT_SPACE,
        seeds = [RISK_SET_SEED, market.key().as_ref(), &[closure_type]], bump,
    )]
    pub risk_set: Box<Account<'info, RiskSet>>,
    pub system_program: Program<'info, System>,
}

/// Loads a calibrated set's lowest `z_tail` values (sorted ascending) and its size and hash (setScenarioSet).
/// The first load also sets σ and its floor; later σ changes go through `update_sigma`.
pub fn handle_set_scenario_set(
    ctx: Context<SetScenarioSet>,
    closure_type: u8,
    n: u32,
    scenario_hash: [u8; 32],
    z_tail: Vec<i16>,
    sigma: u64,
    sigma_floor: u64,
) -> Result<()> {
    require!(
        matches!(closure_type, CLOSURE_OVERNIGHT | CLOSURE_WEEKEND | CLOSURE_HOLIDAY_WEEKEND),
        FinityError::InvalidScenarioSet
    );
    require!(
        !z_tail.is_empty() && z_tail.len() <= MAX_Z_TAIL && z_tail.len() as u32 <= n && z_tail.windows(2).all(|w| w[0] <= w[1]),
        FinityError::InvalidScenarioSet
    );
    let r = &mut ctx.accounts.risk_set;
    let first = r.market == Pubkey::default();
    r.market = ctx.accounts.market.key();
    r.closure_type = closure_type;
    r.n = n;
    r.scenario_hash = scenario_hash;
    r.z_tail = z_tail;
    r.bump = ctx.bumps.risk_set;
    if first {
        require!(sigma >= sigma_floor, FinityError::SigmaDecreaseTooFast);
        r.sigma = sigma;
        r.sigma_floor = sigma_floor;
        r.sigma_at = Clock::get()?.unix_timestamp;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateSigma<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    #[account(mut, seeds = [RISK_SET_SEED, risk_set.market.as_ref(), &[risk_set.closure_type]], bump = risk_set.bump)]
    pub risk_set: Box<Account<'info, RiskSet>>,
}

/// σ update (RiskEngine.updateSigma): up by any amount, down at most 10% per elapsed day, never below the floor.
pub fn handle_update_sigma(ctx: Context<UpdateSigma>, sigma: u64) -> Result<()> {
    require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.risk_config.sigma_oracle, FinityError::NotSigmaOracle);
    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.risk_set;
    require!(sigma >= r.sigma_floor, FinityError::SigmaDecreaseTooFast);
    if sigma < r.sigma {
        let days = (now.saturating_sub(r.sigma_at) / DAY_SECS) as u64;
        require!(sigma as u128 >= risk::sigma_min_allowed(r.sigma as u128, days)?, FinityError::SigmaDecreaseTooFast);
    }
    r.sigma = sigma;
    r.sigma_at = now;
    Ok(())
}

/// Admin: σ floor of a set (setSigmaFloor). Raising it above σ also raises σ.
pub fn handle_set_sigma_floor(ctx: Context<SetScenarioSet>, closure_type: u8, floor: u64) -> Result<()> {
    let r = &mut ctx.accounts.risk_set;
    require!(r.market == ctx.accounts.market.key() && r.closure_type == closure_type, FinityError::WrongRiskSet);
    r.sigma_floor = floor;
    if r.sigma < floor {
        r.sigma = floor;
    }
    Ok(())
}
