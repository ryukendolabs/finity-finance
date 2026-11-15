use anchor_lang::prelude::*;

use crate::{constants::*, error::FinityError, math::*};

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Bot key allowed to push prices and toggle market sessions.
    pub keeper: Pubkey,
    pub usdc_mint: Pubkey,
    pub bump: u8,
    pub usdc_vault_bump: u8,
}

/// Trading session of the underlying stock market.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Session {
    Open,
    Closed,
    Halted,
}

/// Kinked interest-rate model, WAD per year.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug, Default)]
pub struct RateParams {
    pub r0: u64,
    pub s1: u64,
    pub s2: u64,
    pub u_kink: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub collateral_mint: Pubkey,
    #[max_len(8)]
    pub symbol: String,
    pub collateral_decimals: u8,
    /// USDC base units per one whole collateral token.
    pub price: u64,
    pub price_updated_at: i64,
    pub session: Session,
    /// Borrow limit while the market is open.
    pub max_ltv_bps: u16,
    /// Closure-safe borrow limit while the market is closed or halted.
    pub closed_ltv_bps: u16,
    pub liq_threshold_bps: u16,
    pub liq_bonus_bps: u16,
    pub total_collateral: u64,
    // ── lending (MarketState) ──
    /// Owed to the senior vault: its supply plus its share of interest.
    pub total_supply_assets: u64,
    pub total_borrow_assets: u64,
    pub total_borrow_shares: u128,
    /// Interest receivables of the underwriter pool and the treasury (R-09).
    pub pool_fee_accrued: u64,
    pub treasury_fee_accrued: u64,
    pub last_accrual: i64,
    pub fee_pool_bps: u16,
    pub fee_treasury_bps: u16,
    pub rate: RateParams,
    pub supply_cap: u64,
    pub borrow_cap: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Market {
    pub fn validate_params(max_ltv_bps: u16, closed_ltv_bps: u16, liq_threshold_bps: u16, liq_bonus_bps: u16) -> Result<()> {
        require!(
            closed_ltv_bps > 0
                && closed_ltv_bps <= max_ltv_bps
                && max_ltv_bps < liq_threshold_bps
                && (liq_threshold_bps as u64) < BPS
                && liq_bonus_bps <= MAX_LIQ_BONUS_BPS,
            FinityError::InvalidRiskParams
        );
        Ok(())
    }

    pub fn validate_rate(r: &RateParams) -> Result<()> {
        require!(r.u_kink > 0 && (r.u_kink as u128) < WAD, FinityError::InvalidRiskParams);
        Ok(())
    }

    /// The LTV new borrowing (and withdrawing against debt) may reach right now.
    pub fn borrow_ltv_bps(&self) -> u16 {
        match self.session {
            Session::Open => self.max_ltv_bps,
            Session::Closed | Session::Halted => self.closed_ltv_bps,
        }
    }

    pub fn require_fresh_price(&self, now: i64) -> Result<()> {
        require!(now.saturating_sub(self.price_updated_at) <= MAX_PRICE_AGE_SECS, FinityError::StalePrice);
        Ok(())
    }

    fn scale(&self) -> u128 {
        10u128.pow(self.collateral_decimals as u32)
    }

    /// USDC value of `amount` collateral base units.
    pub fn collateral_value(&self, amount: u64) -> Result<u128> {
        self.collateral_value_at(amount, self.price)
    }

    /// USDC value of `amount` collateral base units at `price`.
    pub fn collateral_value_at(&self, amount: u64, price: u64) -> Result<u128> {
        mul_div(amount as u128, price as u128, self.scale())
    }

    /// USDC value of `collateral` scaled by `bps`.
    pub fn limit(&self, collateral: u64, bps: u16) -> Result<u128> {
        Ok(self.collateral_value(collateral)? * bps as u128 / BPS as u128)
    }

    /// Collateral (base units) a liquidator receives for repaying `repay` USDC, bonus included.
    pub fn seize_for(&self, repay: u64) -> Result<u64> {
        let num = (repay as u128) * (BPS as u128 + self.liq_bonus_bps as u128);
        to_u64(mul_div(num, self.scale(), BPS as u128 * self.price as u128)?)
    }

    // ── lending ──

    /// Current borrow rate, WAD per year.
    pub fn borrow_rate(&self) -> Result<u128> {
        let u = utilization(self.total_borrow_assets as u128, self.total_supply_assets as u128)?;
        let r = &self.rate;
        kinked_rate(u, r.r0 as u128, r.s1 as u128, r.s2 as u128, r.u_kink as u128)
    }

    /// Accrues interest to `now` (MarketLib.accrue). Returns the senior share, which the vault adds to its total.
    pub fn accrue(&mut self, now: i64) -> Result<u64> {
        let dt = now.saturating_sub(self.last_accrual);
        if dt <= 0 {
            return Ok(0);
        }
        self.last_accrual = now;
        if self.total_borrow_assets == 0 {
            return Ok(0);
        }
        let i = to_u64(interest(self.total_borrow_assets as u128, self.borrow_rate()?, dt as u128)?)?;
        if i == 0 {
            return Ok(0);
        }
        // QA-06: floor both fee shares once, together, so the senior remainder never falls as i grows.
        let fees = (i as u128 * (self.fee_pool_bps as u128 + self.fee_treasury_bps as u128) / BPS as u128) as u64;
        let fp = (i as u128 * self.fee_pool_bps as u128 / BPS as u128) as u64;
        let ft = fees - fp;
        let senior = i - fees;
        self.total_borrow_assets = self.total_borrow_assets.checked_add(i).ok_or(FinityError::MathOverflow)?;
        self.pool_fee_accrued += fp;
        self.treasury_fee_accrued += ft;
        self.total_supply_assets = self.total_supply_assets.checked_add(senior).ok_or(FinityError::MathOverflow)?;
        Ok(senior)
    }

    /// Cash attributable to the market: S + F_pool + F_treasury − B.
    pub fn liquidity(&self) -> u64 {
        let cash = self.total_supply_assets as u128 + self.pool_fee_accrued as u128 + self.treasury_fee_accrued as u128;
        cash.saturating_sub(self.total_borrow_assets as u128) as u64
    }

    /// Debt of `shares` borrow shares, rounded up.
    pub fn debt_of(&self, shares: u128) -> Result<u64> {
        to_u64(to_assets_up(
            shares,
            self.total_borrow_assets as u128,
            self.total_borrow_shares,
            VIRTUAL_SHARES,
            VIRTUAL_ASSETS,
        )?)
    }

    /// Records a borrow of `assets`; returns the borrow shares minted (rounded up).
    pub fn add_borrow(&mut self, assets: u64) -> Result<u128> {
        let shares = to_shares_up(
            assets as u128,
            self.total_borrow_assets as u128,
            self.total_borrow_shares,
            VIRTUAL_SHARES,
            VIRTUAL_ASSETS,
        )?;
        self.total_borrow_assets = self.total_borrow_assets.checked_add(assets).ok_or(FinityError::MathOverflow)?;
        self.total_borrow_shares += shares;
        Ok(shares)
    }

    /// Records a repayment of `assets` against a position holding `held` shares. Repaying the whole debt burns
    /// every share, so no dust is left. Returns the shares burned.
    pub fn remove_borrow(&mut self, assets: u64, held: u128) -> Result<u128> {
        let debt = self.debt_of(held)?;
        let shares = if assets >= debt {
            held
        } else {
            to_shares_down(
                assets as u128,
                self.total_borrow_assets as u128,
                self.total_borrow_shares,
                VIRTUAL_SHARES,
                VIRTUAL_ASSETS,
            )?
            .min(held)
        };
        self.total_borrow_assets = self.total_borrow_assets.saturating_sub(assets);
        self.total_borrow_shares -= shares;
        Ok(shares)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub collateral: u64,
    pub borrow_shares: u128,
    pub bump: u8,
}

/// The senior lenders' vault: USDC in, shares out; supplies the markets up to their caps.
#[account]
#[derive(InitSpace)]
pub struct SeniorVault {
    pub share_mint: Pubkey,
    pub allocator: Pubkey,
    /// Unallocated USDC (excludes processed-but-unclaimed redemptions).
    pub idle: u64,
    /// Σ total_supply_assets of the vault's markets, kept in step with every accrual, supply and withdrawal.
    pub total_supplied: u64,
    pub claimable_assets: u64,
    pub pending_redeem_shares: u64,
    pub queue_head: u64,
    pub next_request_id: u64,
    /// Enabled markets, in order; every instruction that values the vault takes them all as remaining accounts.
    #[max_len(8)]
    pub markets: Vec<Pubkey>,
    #[max_len(8)]
    pub caps: Vec<u64>,
    /// Indexes into `markets`.
    #[max_len(8)]
    pub supply_queue: Vec<u8>,
    #[max_len(8)]
    pub withdraw_queue: Vec<u8>,
    pub bump: u8,
    pub share_mint_bump: u8,
    pub escrow_bump: u8,
    pub dead_bump: u8,
}

impl SeniorVault {
    pub fn total_assets(&self) -> u128 {
        self.idle as u128 + self.total_supplied as u128
    }

    pub fn to_shares(&self, assets: u64, share_supply: u64) -> Result<u64> {
        to_u64(to_shares_down(assets as u128, self.total_assets(), share_supply as u128, VAULT_VIRTUAL_SHARES, VAULT_VIRTUAL_ASSETS)?)
    }

    pub fn to_assets(&self, shares: u64, share_supply: u64) -> Result<u64> {
        to_u64(to_assets_down(shares as u128, self.total_assets(), share_supply as u128, VAULT_VIRTUAL_SHARES, VAULT_VIRTUAL_ASSETS)?)
    }
}

/// A queued redemption (RedeemRequest): shares escrowed now, paid at the share price when processed.
#[account]
#[derive(InitSpace)]
pub struct RedeemRequest {
    pub id: u64,
    pub owner: Pubkey,
    pub shares: u64,
    pub assets: u64,
    pub processed: bool,
    pub claimed: bool,
    pub created_at: i64,
    pub bump: u8,
}

// ───────────── market clock ─────────────

/// One exchange session, UTC unix seconds (CalendarStore `Session`). Fixed layout: read in place, never decoded.
#[zero_copy]
#[derive(Debug, PartialEq, Eq)]
pub struct SessionRec {
    pub ext_open: u32,
    pub open: u32,
    pub close: u32,
    pub ext_close: u32,
    /// Type of the closure that starts at `close` (1 overnight, 2 weekend, 3 holiday weekend).
    pub closure_type_after: u8,
    pub _pad: [u8; 3],
}

/// `append_sessions` argument (the stored record carries padding).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SessionArg {
    pub ext_open: u32,
    pub open: u32,
    pub close: u32,
    pub ext_close: u32,
    pub closure_type_after: u8,
}

/// Append-only sessions of one venue, precomputed off-chain in UTC (no timezone logic on-chain). Zero-copy:
/// a poke reads only the sessions it needs instead of decoding the whole year.
#[account(zero_copy)]
pub struct Calendar {
    pub venue: [u8; 8],
    pub len: u32,
    pub bump: u8,
    pub _pad: [u8; 3],
    pub sessions: [SessionRec; 300],
}

impl Calendar {
    pub fn live(&self) -> &[SessionRec] {
        &self.sessions[..self.len as usize]
    }
}

/// Most restrictive wins: CorpAction > Halted > Closed > Reopen > Extended > Regular.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ClockState {
    Regular,
    Extended,
    Closed,
    Reopen,
    Halted,
    CorpAction,
}

impl ClockState {
    pub fn rank(self) -> u8 {
        match self {
            ClockState::Regular => 0,
            ClockState::Extended => 1,
            ClockState::Reopen => 2,
            ClockState::Closed => 3,
            ClockState::Halted => 4,
            ClockState::CorpAction => 5,
        }
    }
}

/// Per-market clock (AssetClock `ClockData`): a lazy state machine advanced by `poke`.
#[account]
#[derive(InitSpace)]
pub struct AssetClock {
    pub market: Pubkey,
    pub calendar: Pubkey,
    pub state: ClockState,
    /// ++ at every scheduled close, halt or corporate action.
    pub closure_id: u64,
    pub closure_type: u8,
    /// Calendar index of the session whose close opened the current closure.
    pub venue_epoch: u32,
    /// Scheduled closes already opened (one closure per close, even across missed pokes).
    pub closed_sessions: u32,
    pub session_cursor: u32,
    pub close_at: i64,
    /// Scheduled open that ends the current closure (0 = unknown).
    pub reopen_at: i64,
    pub reopen_pending: bool,
    /// Last price at the close, frozen for the closure.
    pub ref_price: u64,
    pub ref_time: i64,
    /// First price after the reopen, written once per closure.
    pub open_print: u64,
    pub open_print_at: i64,
    pub reopen_ends_at: i64,
    pub next_close_at: i64,
    pub next_closure_type: u8,
    pub next_reopen_at: i64,
    pub bell_window_at: i64,
    pub bell_at: i64,
    /// Guardian restriction (Closed or Halted) until `restriction_until`.
    pub restriction: ClockState,
    pub restriction_until: i64,
    pub corporate_action: bool,
    pub bump: u8,
}

// ───────────── risk engine ─────────────

/// Global risk parameters (RiskEngine `RiskParams`), WAD unless noted.
#[account]
#[derive(InitSpace)]
pub struct RiskConfig {
    /// The only σ writer (SigmaOracle); the keeper on devnet.
    pub sigma_oracle: Pubkey,
    pub alpha: u64,
    pub beta: u64,
    pub kappa: u64,
    pub theta: u64,
    pub cost_of_cap: u64,
    pub eta: u64,
    /// Loan base units.
    pub min_premium: u64,
    pub u_max: u64,
    pub k_stress: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub struct RiskConfigParams {
    pub alpha: u64,
    pub beta: u64,
    pub kappa: u64,
    pub theta: u64,
    pub cost_of_cap: u64,
    pub eta: u64,
    pub min_premium: u64,
    pub u_max: u64,
    pub k_stress: u32,
}

/// One (market, closure type): σ and the lowest scenarios of its calibrated set (R-14).
#[account]
#[derive(InitSpace)]
pub struct RiskSet {
    pub market: Pubkey,
    pub closure_type: u8,
    /// Size of the full calibrated set.
    pub n: u32,
    /// Content hash of the full set, as published in the risk bundle.
    pub scenario_hash: [u8; 32],
    pub sigma: u64,
    pub sigma_floor: u64,
    pub sigma_at: i64,
    /// Known dividend inside the closure, WAD fraction of price.
    pub dividend: u64,
    #[max_len(256)]
    pub z_tail: Vec<i16>,
    pub bump: u8,
}

// ───────────── underwriter pool and Gap Cover ─────────────

/// Junior first-loss capital of one venue. Its USDC sits in the protocol vault; this is
/// its ledger. NAV = cash − unearned premiums − queued deposits − reserved withdrawals.
#[account]
#[derive(InitSpace)]
pub struct UnderwriterPool {
    pub venue: [u8; 8],
    pub calendar: Pubkey,
    pub share_mint: Pubkey,
    pub cash: u64,
    /// Premiums of the open epoch, earned at its settlement.
    pub unearned_premiums: u64,
    /// Deposits waiting for the open epoch's settlement price.
    pub deposits_queued: u64,
    /// Settled withdrawals not yet claimed.
    pub withdraw_reserved: u64,
    /// Withdrawal shares escrowed for the next epoch to be opened.
    pub next_withdraw_shares: u64,
    /// Epochs opened so far; the open one (if any) is number `epochs_opened`.
    pub epochs_opened: u64,
    pub epoch_active: bool,
    /// Calendar index of the last epoch's close (an epoch is never opened twice for one closure).
    pub last_session: u64,
    pub losses_paid: u64,
    #[max_len(8)]
    pub markets: Vec<Pubkey>,
    pub bump: u8,
    pub share_mint_bump: u8,
    pub escrow_bump: u8,
    /// Backstop inventory at its mark, Σ min(qty × (1 − κ) × V, cost) as of each inventory's last touch (§8.6.1).
    pub inventory_mark: u64,
    /// T-Bill redemption claims carried at what the pool paid for them (§8.8).
    pub claims_cost: u64,
    /// Redemptions requested so far (the next one's id is this + 1).
    pub redemptions: u64,
}

impl UnderwriterPool {
    /// Cash the pool can spend: what it holds less premiums not yet earned, queued deposits and reserved
    /// withdrawals. Every payment out of the pool is capped by this.
    pub fn free_cash(&self) -> u64 {
        self.cash
            .saturating_sub(self.unearned_premiums)
            .saturating_sub(self.deposits_queued)
            .saturating_sub(self.withdraw_reserved)
    }

    /// NAV (§8.6.1): free cash + inventory mark + redemption claims. Prices shares and the epoch's equity at risk.
    pub fn nav(&self) -> u64 {
        self.free_cash().saturating_add(self.inventory_mark).saturating_add(self.claims_cost)
    }
}

/// The pool's backstop inventory of one collateral token, held in the pool's associated token account (F-4.5e).
#[account]
#[derive(InitSpace)]
pub struct Inventory {
    pub pool: Pubkey,
    pub market: Pubkey,
    pub mint: Pubkey,
    /// Tokens held (including the part on sale in the running GDA).
    pub qty: u64,
    /// USDC the pool paid for `qty`.
    pub cost: u64,
    /// This inventory's share of `pool.inventory_mark`.
    pub mark: u64,
    /// A T-Bill fund (USBANK): redeemed with the fund instead of resold.
    pub nav: bool,
    pub gda: Gda,
    pub gdas_started: u64,
    pub bump: u8,
}

/// A continuous gradual Dutch auction over inventory (F-4.5e): unit u becomes available at start + u / r and its
/// price decays from k at rate λ, floored at (1 − κ) × V.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug, Default)]
pub struct Gda {
    pub active: bool,
    pub qty: u64,
    pub sold: u64,
    /// k: USDC base units per whole token.
    pub k: u64,
    /// λ, WAD per second.
    pub decay: u64,
    /// r: token base units per second.
    pub emission_per_sec: u64,
    pub start: i64,
}

/// A T-Bill redemption the pool requested from the fund for backstop inventory (§8.8): carried in NAV at `cost`
/// until it is claimed at the fund's NAV once the redemption is fulfilled.
#[account]
#[derive(InitSpace)]
pub struct Redemption {
    pub pool: Pubkey,
    pub market: Pubkey,
    pub id: u64,
    pub qty: u64,
    pub cost: u64,
    pub requested_at: i64,
    pub ready_at: i64,
    pub claimed: bool,
    pub assets: u64,
    pub bump: u8,
}

/// One closure of a pool (R-10), from its opening (before or in the Bell window) to its settlement after the reopen.
/// Zero-copy: the two 256-scenario loss vectors are read in place.
#[account(zero_copy)]
pub struct Epoch {
    pub pool: Pubkey,
    /// Pool sequence number (1, 2, …).
    pub seq: u64,
    /// Calendar index of the session whose close starts the closure.
    pub session: u64,
    pub bell_window_at: i64,
    pub bell_at: i64,
    pub close_at: i64,
    pub reopen_at: i64,
    /// J: pool NAV frozen at the Bell deadline (0 until the snapshot).
    pub equity_at_risk: u64,
    pub nav_before: u64,
    pub nav_after: u64,
    /// Share supply at settlement (with the escrowed withdrawal shares), the price denominator.
    pub settle_supply: u64,
    pub premiums: u64,
    pub losses_paid: u64,
    pub withdraw_shares_queued: u64,
    pub withdraw_assets_reserved: u64,
    pub deposit_assets_queued: u64,
    pub deposit_shares_minted: u64,
    pub policies: u32,
    pub phase: u8,
    pub closure_type: u8,
    pub bump: u8,
    pub _pad: u8,
    /// Σ of every policy's loss in each joint scenario.
    pub policy_losses: [u64; 256],
    /// Σ over markets of the uncovered bound B_m,j.
    pub uncovered: [u64; 256],
}

/// One market's uncovered exposure in an epoch (refreshed by keepers and by every cover).
#[account(zero_copy)]
pub struct EpochMarket {
    pub epoch: Pubkey,
    pub market: Pubkey,
    pub covered_collateral: u64,
    pub refreshed_at: i64,
    pub bounds: [u64; 256],
}

/// Gap Cover bought by one loan for one closure.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub closure_id: u64,
    pub epoch_seq: u64,
    pub premium: u64,
    pub collateral: u64,
    pub debt_projected: u64,
    /// Written by the Bell (premium added to debt) rather than bought by the borrower.
    pub auto: bool,
    pub bump: u8,
}

/// A depositor's queued deposit or escrowed withdrawal for one epoch.
#[account]
#[derive(InitSpace)]
pub struct PoolTicket {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub epoch_seq: u64,
    pub deposit_assets: u64,
    pub withdraw_shares: u64,
    pub bump: u8,
}

/// Second loss layer, funded by the treasury's share of interest.
#[account]
#[derive(InitSpace)]
pub struct ProtocolReserve {
    pub cash: u64,
    pub losses_paid: u64,
    pub bump: u8,
}

/// An asset's column of the joint stress set (K scenarios, same row order for every asset).
#[account]
#[derive(InitSpace)]
pub struct JointColumn {
    pub market: Pubkey,
    pub hash: [u8; 32],
    #[max_len(256)]
    pub z: Vec<i16>,
    pub bump: u8,
}

// ───────────── auctions ─────────────

/// Per-market auction counter and the joinable auction of each kind (AuctionHouse.getOrCreate).
#[account]
#[derive(InitSpace)]
pub struct AuctionBook {
    pub market: Pubkey,
    pub next_id: u64,
    /// Joinable auctions (0 = none): INTRADAY by id; REOPEN / PRECLOSE also by the closure they belong to.
    pub intraday: u64,
    pub reopen: u64,
    pub reopen_closure: u64,
    pub preclose: u64,
    pub preclose_closure: u64,
    pub bump: u8,
}

/// One uniform-price batch auction of a market's collateral (AuctionHouse `Auction` + market `LotInfo`).
#[account]
#[derive(InitSpace)]
pub struct Auction {
    pub market: Pubkey,
    pub id: u64,
    pub kind: u8,
    pub phase: u8,
    pub closure_id: u64,
    /// [lotFixAt, biddingStart, commitEnd/biddingEnd, clearAt], unix seconds.
    pub deadlines: [i64; 4],
    /// Q: collateral base units released by the fixed positions.
    pub lot: u64,
    /// R: USDC base units per whole token (final at clearing for the open kinds).
    pub reserve: u64,
    /// V at creation (INTRADAY) or at lot fixing (PRECLOSE).
    pub start_price: u64,
    pub p_star: u64,
    pub blended_price: u64,
    pub filled: u64,
    pub q_pool: u64,
    /// USDC the lot raised (bidders at p* + the pool at R), attributed to positions as they settle.
    pub proceeds: u64,
    pub pool_paid: u64,
    pub bonds_forfeited: u64,
    pub positions: u32,
    pub fixed: u32,
    pub settled: u32,
    pub bid_count: u16,
    pub revealed: u16,
    pub bump: u8,
    /// A T-Bill fund lot: reserve at κ_nav, the pool's backstop is redeemed with the fund (§8.8).
    pub nav: bool,
}

/// A position's place in a lot (LotEntry): x sold out of q_before, target LTV for a pre-close sale.
#[account]
#[derive(InitSpace)]
pub struct LotEntry {
    pub auction: Pubkey,
    pub owner: Pubkey,
    pub qty: u64,
    pub qty_before: u64,
    /// WAD; 0 = H* sizing (REOPEN / INTRADAY).
    pub target_ltv: u64,
    pub fixed: bool,
    pub settled: bool,
    pub bump: u8,
}

/// A bid: sealed (REOPEN, commitment + bond, revealed later) or open (firm, escrowed now).
#[account]
#[derive(InitSpace)]
pub struct Bid {
    pub auction: Pubkey,
    pub bidder: Pubkey,
    pub commitment: [u8; 32],
    pub max_notional: u64,
    pub bond: u64,
    pub qty: u64,
    /// USDC base units per whole token.
    pub price: u64,
    /// USDC held for this bid (bond included).
    pub escrow: u64,
    pub fill: u64,
    pub revealed: bool,
    pub claimed: bool,
    pub bump: u8,
}

/// One lot at a time per loan: set when the loan joins an auction, cleared when its
/// part of the lot settles.
#[account]
#[derive(InitSpace)]
pub struct PositionLock {
    pub position: Pubkey,
    pub auction: Pubkey,
    pub bump: u8,
}

// ───────────── oracle and guardian ─────────────

/// The price signers (relayer nodes) and the rules a signed report must meet.
#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    #[max_len(8)]
    pub signers: Vec<Pubkey>,
    /// k of n distinct signers must agree on a market's report set.
    pub threshold: u8,
    pub max_delay_secs: i64,
    pub max_ahead_secs: i64,
    /// Devnet escape hatch: lets the keeper/admin `set_price` directly (off by default: prices come signed).
    pub keeper_price_allowed: bool,
    pub bump: u8,
}

/// Emergency controls (FinityGuardian): pauses and a temporary max-LTV haircut, held by a separate key.
#[account]
#[derive(InitSpace)]
pub struct GuardianState {
    pub guardian: Pubkey,
    pub borrow_paused: bool,
    pub cover_paused: bool,
    pub haircut_bps: u16,
    pub haircut_until: i64,
    pub bump: u8,
}

impl GuardianState {
    /// Max LTV after an active haircut, in bps.
    pub fn max_ltv_eff(&self, max_ltv_bps: u16, now: i64) -> u16 {
        if self.haircut_until > now {
            max_ltv_bps.saturating_sub(self.haircut_bps)
        } else {
            max_ltv_bps
        }
    }
}

/// Present = the borrower switched auto-cover off for this loan: at the Bell a
/// loan above its safe LTV is sold down before the close instead of being covered.
#[account]
#[derive(InitSpace)]
pub struct AutoCoverOptOut {
    pub position: Pubkey,
    pub bump: u8,
}
