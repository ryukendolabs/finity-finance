//! Underwriter pool (§8.6): junior first-loss capital in calendar epochs, the protocol
//! reserve, joint stress columns, capacity refreshes and the interest-fee sweep.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::{clock as clk, constants::*, error::FinityError, math::*, risk, state::*};

fn to_pool_shares(assets: u64, nav: u64, supply: u64) -> Result<u64> {
    to_u64(to_shares_down(assets as u128, nav as u128, supply as u128, POOL_VIRTUAL_SHARES, POOL_VIRTUAL_ASSETS)?)
}

fn to_pool_assets(shares: u64, nav: u64, supply: u64) -> Result<u64> {
    to_u64(to_assets_down(shares as u128, nav as u128, supply as u128, POOL_VIRTUAL_SHARES, POOL_VIRTUAL_ASSETS)?)
}

// ---------- setup (admin) ----------

#[derive(Accounts)]
#[instruction(venue: [u8; 8])]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [CALENDAR_SEED, &venue], bump)]
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(init, payer = admin, space = 8 + UnderwriterPool::INIT_SPACE, seeds = [POOL_SEED, &venue], bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(
        init, payer = admin, seeds = [POOL_SHARES_SEED, &venue], bump,
        mint::decimals = POOL_SHARE_DECIMALS, mint::authority = pool, mint::token_program = token_program,
    )]
    pub share_mint: Box<Account<'info, Mint>>,
    /// Escrowed withdrawal shares and minted-but-unclaimed deposit shares.
    #[account(
        init, payer = admin, seeds = [POOL_ESCROW_SEED, &venue], bump,
        token::mint = share_mint, token::authority = pool, token::token_program = token_program,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_pool(ctx: Context<InitPool>, venue: [u8; 8]) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    p.venue = venue;
    p.calendar = ctx.accounts.calendar.key();
    p.share_mint = ctx.accounts.share_mint.key();
    p.last_session = u64::MAX;
    p.bump = ctx.bumps.pool;
    p.share_mint_bump = ctx.bumps.share_mint;
    p.escrow_bump = ctx.bumps.escrow;
    Ok(())
}

#[derive(Accounts)]
pub struct InitReserve<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + ProtocolReserve::INIT_SPACE, seeds = [RESERVE_SEED], bump)]
    pub reserve: Box<Account<'info, ProtocolReserve>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_reserve(ctx: Context<InitReserve>) -> Result<()> {
    ctx.accounts.reserve.bump = ctx.bumps.reserve;
    Ok(())
}

#[derive(Accounts)]
pub struct AddPoolMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market)]
    pub clock: Box<Account<'info, AssetClock>>,
}

/// Binds a market to the pool of its venue (the market's clock runs on the pool's calendar).
pub fn handle_add_pool_market(ctx: Context<AddPoolMarket>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require_keys_eq!(ctx.accounts.clock.calendar, pool.calendar, FinityError::WrongPool);
    let m = ctx.accounts.market.key();
    require!(!pool.markets.contains(&m), FinityError::WrongPool);
    require!(pool.markets.len() < MAX_POOL_MARKETS, FinityError::TooManyMarkets);
    pool.markets.push(m);
    Ok(())
}

#[derive(Accounts)]
pub struct SetJointColumn<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init_if_needed, payer = admin, space = 8 + JointColumn::INIT_SPACE, seeds = [JOINT_SEED, market.key().as_ref()], bump)]
    pub joint: Box<Account<'info, JointColumn>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_joint_column(ctx: Context<SetJointColumn>, hash: [u8; 32], z: Vec<i16>) -> Result<()> {
    require!(z.len() == K_STRESS, FinityError::InvalidJointColumn);
    let j = &mut ctx.accounts.joint;
    j.market = ctx.accounts.market.key();
    j.hash = hash;
    j.z = z;
    j.bump = ctx.bumps.joint;
    Ok(())
}

// ---------- deposits and withdrawals ----------

#[derive(Accounts)]
pub struct PoolDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump, has_one = share_mint)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
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
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn pull_usdc<'info>(tp: &Program<'info, Token>, from: AccountInfo<'info>, to: AccountInfo<'info>, auth: AccountInfo<'info>, a: u64) -> Result<()> {
    token::transfer(CpiContext::new(tp.key(), Transfer { from, to, authority: auth }), a)
}

/// Between epochs: shares at the current NAV, at once.
pub fn handle_pool_deposit(ctx: Context<PoolDeposit>, assets: u64) -> Result<()> {
    require!(assets > 0, FinityError::ZeroAmount);
    let pool = &ctx.accounts.pool;
    require!(!pool.epoch_active, FinityError::EpochNotReady);
    let shares = to_pool_shares(assets, pool.nav(), ctx.accounts.share_mint.supply)?;
    require!(shares > 0, FinityError::ZeroShares);
    let a = &ctx.accounts;
    pull_usdc(&a.token_program, a.owner_usdc.to_account_info(), a.usdc_vault.to_account_info(), a.owner.to_account_info(), assets)?;
    let venue = a.pool.venue;
    let seeds: &[&[u8]] = &[POOL_SEED, &venue, &[a.pool.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            a.token_program.key(),
            MintTo { mint: a.share_mint.to_account_info(), to: a.owner_shares.to_account_info(), authority: a.pool.to_account_info() },
            &[seeds],
        ),
        shares,
    )?;
    ctx.accounts.pool.cash += assets;
    Ok(())
}

#[derive(Accounts)]
pub struct PoolDepositQueued<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [EPOCH_SEED, pool.key().as_ref(), &pool.epochs_opened.to_le_bytes()], bump)]
    pub epoch: AccountLoader<'info, Epoch>,
    #[account(
        init_if_needed, payer = owner, space = 8 + PoolTicket::INIT_SPACE,
        seeds = [POOL_TICKET_SEED, pool.key().as_ref(), owner.key().as_ref(), &pool.epochs_opened.to_le_bytes()], bump,
    )]
    pub ticket: Box<Account<'info, PoolTicket>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// During an epoch: the deposit waits for the epoch's settlement price (it takes no part in this closure's risk).
pub fn handle_pool_deposit_queued(ctx: Context<PoolDepositQueued>, assets: u64) -> Result<()> {
    require!(assets > 0, FinityError::ZeroAmount);
    require!(ctx.accounts.pool.epoch_active, FinityError::NoOpenEpoch);
    let a = &ctx.accounts;
    pull_usdc(&a.token_program, a.owner_usdc.to_account_info(), a.usdc_vault.to_account_info(), a.owner.to_account_info(), assets)?;
    let seq = ctx.accounts.pool.epochs_opened;
    let t = &mut ctx.accounts.ticket;
    t.pool = ctx.accounts.pool.key();
    t.owner = ctx.accounts.owner.key();
    t.epoch_seq = seq;
    t.deposit_assets += assets;
    t.bump = ctx.bumps.ticket;
    let pool = &mut ctx.accounts.pool;
    pool.cash += assets;
    pool.deposits_queued += assets;
    ctx.accounts.epoch.load_mut()?.deposit_assets_queued += assets;
    Ok(())
}

#[derive(Accounts)]
pub struct PoolRequestWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump, has_one = share_mint)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub owner_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_ESCROW_SEED, &pool.venue], bump = pool.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = owner, space = 8 + PoolTicket::INIT_SPACE,
        seeds = [POOL_TICKET_SEED, pool.key().as_ref(), owner.key().as_ref(), &(pool.epochs_opened + 1).to_le_bytes()], bump,
    )]
    pub ticket: Box<Account<'info, PoolTicket>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Escrows shares for the next epoch to open; they stay at risk through it and are paid at its settlement price.
pub fn handle_pool_request_withdraw(ctx: Context<PoolRequestWithdraw>, shares: u64) -> Result<()> {
    require!(shares > 0, FinityError::ZeroAmount);
    let a = &ctx.accounts;
    pull_usdc(&a.token_program, a.owner_shares.to_account_info(), a.escrow.to_account_info(), a.owner.to_account_info(), shares)?;
    let seq = ctx.accounts.pool.epochs_opened + 1;
    let t = &mut ctx.accounts.ticket;
    t.pool = ctx.accounts.pool.key();
    t.owner = ctx.accounts.owner.key();
    t.epoch_seq = seq;
    t.withdraw_shares += shares;
    t.bump = ctx.bumps.ticket;
    ctx.accounts.pool.next_withdraw_shares += shares;
    Ok(())
}

#[derive(Accounts)]
#[instruction(seq: u64)]
pub struct PoolClaim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump, has_one = share_mint)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(seeds = [EPOCH_SEED, pool.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub epoch: AccountLoader<'info, Epoch>,
    #[account(
        mut, has_one = owner, has_one = pool, close = owner,
        seeds = [POOL_TICKET_SEED, pool.key().as_ref(), owner.key().as_ref(), &seq.to_le_bytes()], bump = ticket.bump,
    )]
    pub ticket: Box<Account<'info, PoolTicket>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [POOL_ESCROW_SEED, &pool.venue], bump = pool.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = owner,
        associated_token::mint = share_mint, associated_token::authority = owner, associated_token::token_program = token_program,
    )]
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

/// After the epoch settled: the ticket's deposit shares (minted at the settlement price) and its withdrawal assets
/// (reserved at the settlement price). The ticket is closed.
pub fn handle_pool_claim(ctx: Context<PoolClaim>, _seq: u64) -> Result<()> {
    let (dep_shares, wd_assets) = {
        let e = ctx.accounts.epoch.load()?;
        require!(e.phase == EPOCH_SETTLED, FinityError::EpochNotSettled);
        let t = &ctx.accounts.ticket;
        let dep = if t.deposit_assets > 0 && e.deposit_assets_queued > 0 {
            to_u64(mul_div(t.deposit_assets as u128, e.deposit_shares_minted as u128, e.deposit_assets_queued as u128)?)?
        } else {
            0
        };
        let wd = if t.withdraw_shares > 0 && e.withdraw_shares_queued > 0 {
            to_u64(mul_div(t.withdraw_shares as u128, e.withdraw_assets_reserved as u128, e.withdraw_shares_queued as u128)?)?
        } else {
            0
        };
        (dep, wd)
    };
    require!(dep_shares > 0 || wd_assets > 0, FinityError::NothingToClaim);
    let a = &ctx.accounts;
    let venue = a.pool.venue;
    if dep_shares > 0 {
        let seeds: &[&[u8]] = &[POOL_SEED, &venue, &[a.pool.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.key(),
                Transfer { from: a.escrow.to_account_info(), to: a.owner_shares.to_account_info(), authority: a.pool.to_account_info() },
                &[seeds],
            ),
            dep_shares,
        )?;
    }
    if wd_assets > 0 {
        // NAV counts inventory and redemption claims at their mark; the payout needs the cash itself.
        require!(a.pool.cash >= wd_assets, FinityError::PoolIlliquid);
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[a.config.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.key(),
                Transfer { from: a.usdc_vault.to_account_info(), to: a.owner_usdc.to_account_info(), authority: a.config.to_account_info() },
                &[seeds],
            ),
            wd_assets,
        )?;
        let pool = &mut ctx.accounts.pool;
        pool.withdraw_reserved = pool.withdraw_reserved.saturating_sub(wd_assets);
        pool.cash -= wd_assets;
    }
    Ok(())
}

// ---------- epochs (permissionless cranks) ----------

#[derive(Accounts)]
pub struct OpenEpoch<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump, has_one = calendar)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(
        init, payer = cranker, space = 8 + std::mem::size_of::<Epoch>(),
        seeds = [EPOCH_SEED, pool.key().as_ref(), &(pool.epochs_opened + 1).to_le_bytes()], bump,
    )]
    pub epoch: AccountLoader<'info, Epoch>,
    pub system_program: Program<'info, System>,
}

/// Opens the epoch of the next scheduled close, once the previous one has settled. Covers for that closure are
/// written against it; queued deposits and the escrowed withdrawals join it.
pub fn handle_open_epoch(ctx: Context<OpenEpoch>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(!pool.epoch_active, FinityError::EpochNotReady);
    let cal = ctx.accounts.calendar.load()?;
    let s = cal.live();
    let i = (0..s.len()).find(|&i| s[i].close as i64 > now).ok_or(FinityError::ClosureOpenEnded)?;
    require!(pool.last_session == u64::MAX || i as u64 > pool.last_session, FinityError::EpochNotReady);
    let reopen = s.get(i + 1).map(|n| n.open as i64).ok_or(FinityError::ClosureOpenEnded)?;
    let close = s[i].close as i64;

    pool.epochs_opened += 1;
    pool.epoch_active = true;
    pool.last_session = i as u64;
    let mut e = ctx.accounts.epoch.load_init()?;
    e.pool = pool.key();
    e.seq = pool.epochs_opened;
    e.session = i as u64;
    e.close_at = close;
    e.reopen_at = reopen;
    e.bell_window_at = close - BELL_WINDOW_SECS;
    e.bell_at = close - BELL_DEADLINE_SECS;
    e.closure_type = s[i].closure_type_after;
    e.nav_before = pool.nav();
    e.withdraw_shares_queued = pool.next_withdraw_shares;
    e.phase = EPOCH_OPEN;
    e.bump = ctx.bumps.epoch;
    pool.next_withdraw_shares = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct SnapshotEpoch<'info> {
    #[account(seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [EPOCH_SEED, pool.key().as_ref(), &pool.epochs_opened.to_le_bytes()], bump)]
    pub epoch: AccountLoader<'info, Epoch>,
}

/// At the Bell deadline: freeze J, the pool equity the closure's covers are measured against.
pub fn handle_snapshot_epoch(ctx: Context<SnapshotEpoch>) -> Result<()> {
    let mut e = ctx.accounts.epoch.load_mut()?;
    require!(e.phase == EPOCH_OPEN && Clock::get()?.unix_timestamp >= e.bell_at, FinityError::EpochNotReady);
    e.equity_at_risk = ctx.accounts.pool.nav();
    e.phase = EPOCH_SNAPSHOT;
    Ok(())
}

#[derive(Accounts)]
pub struct InitEpochMarket<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(seeds = [EPOCH_SEED, pool.key().as_ref(), &pool.epochs_opened.to_le_bytes()], bump)]
    pub epoch: AccountLoader<'info, Epoch>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init, payer = cranker, space = 8 + std::mem::size_of::<EpochMarket>(),
        seeds = [EPOCH_MARKET_SEED, epoch.key().as_ref(), market.key().as_ref()], bump,
    )]
    pub epoch_market: AccountLoader<'info, EpochMarket>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_epoch_market(ctx: Context<InitEpochMarket>) -> Result<()> {
    require!(ctx.accounts.pool.markets.contains(&ctx.accounts.market.key()), FinityError::WrongPool);
    let mut m = ctx.accounts.epoch_market.load_init()?;
    m.epoch = ctx.accounts.epoch.key();
    m.market = ctx.accounts.market.key();
    Ok(())
}

#[derive(Accounts)]
pub struct RefreshCapacity<'info> {
    #[account(seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [EPOCH_SEED, pool.key().as_ref(), &pool.epochs_opened.to_le_bytes()], bump)]
    pub epoch: AccountLoader<'info, Epoch>,
    #[account(mut, seeds = [EPOCH_MARKET_SEED, epoch.key().as_ref(), market.key().as_ref()], bump)]
    pub epoch_market: AccountLoader<'info, EpochMarket>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    /// The risk set of the epoch's closure type.
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[risk_set.closure_type]], bump = risk_set.bump, has_one = market)]
    pub risk_set: Box<Account<'info, RiskSet>>,
    #[account(seeds = [JOINT_SEED, market.key().as_ref()], bump = joint.bump, has_one = market)]
    pub joint: Box<Account<'info, JointColumn>>,
}

/// Recomputes one market's uncovered bound B_m,j = C_unc × max(0, LTV_safe − g_j) over the K joint scenarios and
/// updates the epoch's aggregate (F-4.4). Permissionless; the keeper runs it every tick and every cover runs it
/// for its own market.
pub fn handle_refresh_capacity(ctx: Context<RefreshCapacity>) -> Result<()> {
    let a = &ctx.accounts;
    let mut e = a.epoch.load_mut()?;
    require!(e.phase == EPOCH_OPEN || e.phase == EPOCH_SNAPSHOT, FinityError::NoOpenEpoch);
    require!(a.risk_set.closure_type == e.closure_type, FinityError::WrongRiskSet);
    let mut em = a.epoch_market.load_mut()?;
    let gs = joint_gaps(&a.joint, &a.risk_config, &a.risk_set)?;
    refresh_bounds(&mut e, &mut em, &a.market, &a.risk_config, &a.risk_set, &gs)?;
    em.refreshed_at = Clock::get()?.unix_timestamp;
    Ok(())
}

/// Shared by `refresh_capacity` and every cover write. `gs` = g(z_j) of the market's joint column.
pub fn refresh_bounds(e: &mut Epoch, em: &mut EpochMarket, market: &Market, cfg: &RiskConfig, set: &RiskSet, gs: &[u128]) -> Result<()> {
    let unc = market.total_collateral.saturating_sub(em.covered_collateral);
    let c_unc = market.collateral_value(unc)?;
    let safe = clk::safe_ltv_wad(market, cfg, set)?;
    for j in 0..K_STRESS {
        let b = risk::uncovered_bound_g(gs[j], c_unc, safe)?;
        e.uncovered[j] = e.uncovered[j].saturating_sub(em.bounds[j]).saturating_add(b);
        em.bounds[j] = b;
    }
    Ok(())
}

pub fn joint_gaps(joint: &JointColumn, cfg: &RiskConfig, set: &RiskSet) -> Result<Vec<u128>> {
    require!(joint.z.len() == K_STRESS, FinityError::InvalidJointColumn);
    risk::gap_factors(&joint.z, set.sigma as u128, set.dividend as u128, cfg.kappa as u128)
}

#[derive(Accounts)]
pub struct SettleEpoch<'info> {
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump, has_one = share_mint)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [EPOCH_SEED, pool.key().as_ref(), &pool.epochs_opened.to_le_bytes()], bump)]
    pub epoch: AccountLoader<'info, Epoch>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [POOL_ESCROW_SEED, &pool.venue], bump = pool.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Remaining accounts: the clock of every pool market (pool order). After every market finished the closure's
/// reopen and the settle delay passed: premiums are earned, the settlement price is set, queued deposits are
/// minted and escrowed withdrawals burned against reserved assets (§8.6.3).
pub fn handle_settle_epoch<'info>(ctx: Context<'info, SettleEpoch<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (close_at, premiums, wd_shares, dep_assets) = {
        let e = ctx.accounts.epoch.load()?;
        require!(e.phase == EPOCH_OPEN || e.phase == EPOCH_SNAPSHOT, FinityError::EpochNotReady);
        require!(now >= e.reopen_at + REOPEN_WINDOW_SECS + SETTLE_DELAY_SECS, FinityError::EpochNotSettleable);
        (e.close_at, e.premiums, e.withdraw_shares_queued, e.deposit_assets_queued)
    };
    let pool = &ctx.accounts.pool;
    require!(ctx.remaining_accounts.len() >= pool.markets.len(), FinityError::WrongMarketAccounts);
    for (i, m) in pool.markets.iter().enumerate() {
        let ai = &ctx.remaining_accounts[i];
        let (expected, _) = Pubkey::find_program_address(&[CLOCK_SEED, m.as_ref()], &crate::ID);
        require_keys_eq!(*ai.key, expected, FinityError::WrongMarketAccounts);
        let c = Account::<AssetClock>::try_from(ai)?;
        require!(!(c.reopen_pending && c.close_at <= close_at), FinityError::EpochNotSettleable);
    }

    let pool = &mut ctx.accounts.pool;
    pool.unearned_premiums = pool.unearned_premiums.saturating_sub(premiums);
    let nav_after = pool.nav();
    let supply = ctx.accounts.share_mint.supply;
    let wd_assets = to_pool_assets(wd_shares, nav_after, supply)?;
    let dep_shares = to_pool_shares(dep_assets, nav_after, supply)?;
    pool.withdraw_reserved += wd_assets;
    pool.deposits_queued = pool.deposits_queued.saturating_sub(dep_assets);
    pool.epoch_active = false;

    {
        let mut e = ctx.accounts.epoch.load_mut()?;
        e.nav_after = nav_after;
        e.settle_supply = supply;
        e.withdraw_assets_reserved = wd_assets;
        e.deposit_shares_minted = dep_shares;
        e.phase = EPOCH_SETTLED;
    }

    let venue = ctx.accounts.pool.venue;
    let seeds: &[&[u8]] = &[POOL_SEED, &venue, &[ctx.accounts.pool.bump]];
    let a = &ctx.accounts;
    if wd_shares > 0 {
        token::burn(
            CpiContext::new_with_signer(
                a.token_program.key(),
                Burn { mint: a.share_mint.to_account_info(), from: a.escrow.to_account_info(), authority: a.pool.to_account_info() },
                &[seeds],
            ),
            wd_shares,
        )?;
    }
    if dep_shares > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                a.token_program.key(),
                MintTo { mint: a.share_mint.to_account_info(), to: a.escrow.to_account_info(), authority: a.pool.to_account_info() },
                &[seeds],
            ),
            dep_shares,
        )?;
    }
    Ok(())
}

// ---------- fee sweep (R-09) ----------

#[derive(Accounts)]
pub struct SweepFees<'info> {
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [RESERVE_SEED], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ProtocolReserve>>,
}

/// Moves a market's accrued interest shares to their owners: ρ_J to the pool, ρ_p to the protocol reserve, as far
/// as the market's cash allows (borrowed cash is swept when repaid). Permissionless.
pub fn handle_sweep_fees(mut ctx: Context<SweepFees>) -> Result<()> {
    let a = &mut ctx.accounts;
    require!(a.pool.markets.contains(&a.market.key()), FinityError::WrongPool);
    crate::instructions::user::accrue(&mut a.market, &mut a.senior)?;
    let m = &mut a.market;
    let mut cash = m.liquidity();
    let fp = m.pool_fee_accrued.min(cash);
    cash -= fp;
    let ft = m.treasury_fee_accrued.min(cash);
    m.pool_fee_accrued -= fp;
    m.treasury_fee_accrued -= ft;
    a.pool.cash += fp;
    a.reserve.cash += ft;
    Ok(())
}

// ---------- close a settled epoch's per-market accounts ----------

#[derive(Accounts)]
pub struct CloseEpochMarket<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub epoch: AccountLoader<'info, Epoch>,
    #[account(
        mut, close = keeper,
        seeds = [EPOCH_MARKET_SEED, epoch.key().as_ref(), epoch_market.load()?.market.as_ref()], bump,
        constraint = epoch_market.load()?.epoch == epoch.key() @ FinityError::WrongPool,
    )]
    pub epoch_market: AccountLoader<'info, EpochMarket>,
    /// CHECK: receives the rent; must be the keeper that pays for epoch accounts.
    #[account(mut, address = config.keeper @ FinityError::NotKeeper)]
    pub keeper: UncheckedAccount<'info>,
}

/// Permissionless, once its epoch is settled: an EpochMarket is only read while its epoch is open (capacity and
/// covers), so it is closed and its rent goes back to the keeper that created it. The Epoch account itself stays:
/// deposit and withdrawal tickets are claimed against it.
pub fn handle_close_epoch_market(ctx: Context<CloseEpochMarket>) -> Result<()> {
    require!(ctx.accounts.epoch.load()?.phase == EPOCH_SETTLED, FinityError::EpochNotReady);
    Ok(())
}
