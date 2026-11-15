//! Seeds carry a layout version: a layout change bumps it so the same program gets fresh accounts on devnet.
pub const CONFIG_SEED: &[u8] = b"v2/config";
pub const MARKET_SEED: &[u8] = b"v2/market";
pub const VAULT_SEED: &[u8] = b"v2/vault";
pub const USDC_VAULT_SEED: &[u8] = b"v2/usdc_vault";
pub const POSITION_SEED: &[u8] = b"v2/position";
pub const SENIOR_SEED: &[u8] = b"v2/senior";
pub const SHARE_MINT_SEED: &[u8] = b"v2/senior_shares";
pub const SHARE_ESCROW_SEED: &[u8] = b"v2/senior_escrow";
pub const DEAD_SHARES_SEED: &[u8] = b"v2/senior_dead";
pub const REDEEM_SEED: &[u8] = b"v2/redeem";

/// Basis points denominator.
pub const BPS: u64 = 10_000;

/// A market price is the USDC value (6 decimals) of one whole collateral token.
pub const USDC_DECIMALS: u8 = 6;

/// Senior vault shares: ERC-4626 style virtual offset (10^3 shares per base unit, 1 asset) and 1e3 dead
/// shares minted on the first deposit (inflation attack). Shares carry 6 + 3 = 9 decimals.
pub const SHARE_DECIMALS: u8 = 9;
pub const VAULT_VIRTUAL_SHARES: u128 = 1_000;
pub const VAULT_VIRTUAL_ASSETS: u128 = 1;
pub const DEAD_SHARES: u64 = 1_000;

/// Markets the senior vault can supply (SeniorVault.MAX_QUEUE is 32; Solana's account limit keeps it at 8).
pub const MAX_VAULT_MARKETS: usize = 8;

/// Borrow, withdraw-with-debt and liquidation all refuse a price older than this.
pub const MAX_PRICE_AGE_SECS: i64 = 600;

/// The faucet mints at most this many whole tokens per call.
pub const FAUCET_MAX_WHOLE: u64 = 1_000;

/// One liquidation repays at most this share of a position's debt...
pub const CLOSE_FACTOR_BPS: u64 = 5_000;
/// ...unless the debt is below this (in USDC base units), when it may all be repaid.
pub const DUST_DEBT: u64 = 10_000_000;

/// Upper bound on the liquidation bonus a market may set.
pub const MAX_LIQ_BONUS_BPS: u16 = 2_000;

/// Interest shares of the underwriter pool and the treasury (ρ_J, ρ_p).
pub const DEFAULT_FEE_POOL_BPS: u16 = 1_000;
pub const DEFAULT_FEE_TREASURY_BPS: u16 = 1_000;

// ───────────── market clock ─────────────
pub const CALENDAR_SEED: &[u8] = b"v2/calendar";
pub const CLOCK_SEED: &[u8] = b"v2/clock";
/// A venue calendar holds up to this many sessions (a year and a bit; appended ahead through governance).
pub const MAX_SESSIONS: usize = 300;
/// The Bell window opens 2 h before a scheduled close; its deadline is 15 min before.
pub const BELL_WINDOW_SECS: i64 = 2 * 3600;
pub const BELL_DEADLINE_SECS: i64 = 15 * 60;
/// REOPEN lasts this long after the open print. The reopen auction (a later stage) will end it instead.
pub const REOPEN_WINDOW_SECS: i64 = 120;
/// A guardian restriction lasts at most 7 days (IAssetClock.restrict).
pub const MAX_RESTRICT_SECS: i64 = 7 * 24 * 3600;
pub const DAY_SECS: i64 = 24 * 3600;

pub const CLOSURE_NONE: u8 = 0;
pub const CLOSURE_OVERNIGHT: u8 = 1;
pub const CLOSURE_WEEKEND: u8 = 2;
pub const CLOSURE_HOLIDAY_WEEKEND: u8 = 3;
pub const CLOSURE_HALT: u8 = 4;
pub const CLOSURE_CORP_ACTION: u8 = 5;

// ───────────── risk engine (RiskEngine / risk-core) ─────────────
pub const RISK_CONFIG_SEED: &[u8] = b"v2/risk_config";
pub const RISK_SET_SEED: &[u8] = b"v2/risk";
/// Lowest z values stored per scenario set: enough for the α quantile and every loss-bearing scenario of a
/// position at or below max LTV; a quote that would need more is refused, never understated.
pub const MAX_Z_TAIL: usize = 256;

// ───────────── underwriter pool, Gap Cover, loss waterfall (UnderwriterPool, CoverLogic, ProtocolReserve) ─────────────
pub const POOL_SEED: &[u8] = b"v2/pool";
pub const POOL_SHARES_SEED: &[u8] = b"v2/pool_shares";
pub const POOL_ESCROW_SEED: &[u8] = b"v2/pool_escrow";
pub const EPOCH_SEED: &[u8] = b"v2/epoch";
pub const EPOCH_MARKET_SEED: &[u8] = b"v2/epoch_mkt";
pub const POLICY_SEED: &[u8] = b"v2/policy";
pub const POOL_TICKET_SEED: &[u8] = b"v2/pool_ticket";
pub const RESERVE_SEED: &[u8] = b"v2/reserve";
pub const JOINT_SEED: &[u8] = b"v2/joint";
/// K joint stress scenarios (R-13).
pub const K_STRESS: usize = 256;
pub const MAX_POOL_MARKETS: usize = 8;
/// Pool shares: 9 decimals, virtual offset 10^3 shares per base unit (as the senior vault).
pub const POOL_SHARE_DECIMALS: u8 = 9;
pub const POOL_VIRTUAL_SHARES: u128 = 1_000;
pub const POOL_VIRTUAL_ASSETS: u128 = 1;
/// An epoch settles this long after every one of its markets finished its reopen.
pub const SETTLE_DELAY_SECS: i64 = 300;
/// R-03: cover may be bought up to max LTV + 0.5 pp, and never above LT − 2 pp.
pub const DELTA_COVER_BPS: u16 = 50;
pub const COVER_LT_GAP_BPS: u16 = 200;

pub const EPOCH_OPEN: u8 = 1;
pub const EPOCH_SNAPSHOT: u8 = 2;
pub const EPOCH_SETTLED: u8 = 3;

// ───────────── auctions (§8.7) ─────────────
pub const AUCTION_BOOK_SEED: &[u8] = b"v2/auction_book";
pub const AUCTION_SEED: &[u8] = b"v2/auction";
pub const LOT_ENTRY_SEED: &[u8] = b"v2/lot_entry";
pub const BID_SEED: &[u8] = b"v2/bid";
pub const INVENTORY_SEED: &[u8] = b"v2/inventory";
pub const LOCK_SEED: &[u8] = b"v2/plock";

pub const KIND_REOPEN: u8 = 0;
pub const KIND_INTRADAY: u8 = 1;
/// Extended hours: a loan below health 1 at the live price, never one covered for the closure in progress.
pub const KIND_EMERGENCY: u8 = 2;
pub const KIND_PRECLOSE: u8 = 3;

pub const PHASE_QUEUE: u8 = 1;
pub const PHASE_BIDDING: u8 = 2; // COMMIT for REOPEN, OPEN_BIDDING for the open kinds
pub const PHASE_REVEAL: u8 = 3;
pub const PHASE_CLEARED: u8 = 4;
pub const PHASE_CANCELLED: u8 = 5;

/// Offsets [lotFixAt, biddingStart, commitEnd/biddingEnd, clearAt] (AuctionHouse `timings`). REOPEN and INTRADAY
/// count from creation (REOPEN: the open print); PRECLOSE counts back from the close.
pub const TIMINGS_REOPEN: [i64; 4] = [120, 120, 300, 420];
pub const TIMINGS_INTRADAY: [i64; 4] = [15, 15, 60, 60];
pub const TIMINGS_PRECLOSE: [i64; 4] = [300, 300, 30, 30];
/// EMERGENCY: a 5-minute batch (thin extended-hours books get longer than the 60 s intraday batch).
pub const TIMINGS_EMERGENCY: [i64; 4] = [60, 60, 300, 300];

/// Positions per auction and bids per auction (a lot is fixed one position at a time; clearing reads every bid).
pub const MAX_LOT_POSITIONS: u32 = 64;
pub const MAX_BIDS: u16 = 16;
/// H* = 1.10: a lot restores this health factor or closes the position.
pub const H_STAR_WAD: u128 = 1_100_000_000_000_000_000;
/// R-04: a sealed bid posts a bond of 10% of its declared maximum notional.
pub const BOND_BPS: u64 = 1_000;
/// R-06: the pre-close batch's κ_pre and λ_pre.
pub const KAPPA_PRE_BPS: u64 = 100;
pub const LAMBDA_PRE_BPS: u64 = 100;
/// §8.8: a T-Bill fund lot's reserve sits κ_nav = 0.5% below the fund's NAV (the settlement adapter's floor).
pub const KAPPA_NAV_BPS: u64 = 50;

// ───────────── backstop inventory: GDA resale and fund redemptions (F-4.5e, §8.8) ─────────────
pub const REDEMPTION_SEED: &[u8] = b"v2/redemption";
/// k = 1.02 × V at listing.
pub const GDA_START_MARKUP_BPS: u64 = 10_200;
/// λ = ln 2 / 86,400 s (WAD per second): the price halves every 24 h.
pub const GDA_DECAY_WAD: u64 = 8_022_536_812_036;
/// r = inventory / 3 days.
pub const GDA_EMISSION_PERIOD: i64 = 3 * 86_400;
/// A GDA can be ended by anyone once it has run twice its emission period.
pub const GDA_MAX_RUN: i64 = 2 * GDA_EMISSION_PERIOD;
/// The test fund fulfils a redemption one day after it is requested (T+1).
pub const REDEMPTION_DELAY: i64 = 86_400;
/// The bank calendar of the T-Bill fund (its pool and auctions follow the NAV rules).
pub const VENUE_USBANK: [u8; 8] = *b"USBANK\0\0";

// ───────────── oracle and guardian (FinityPriceFeed / OracleAdapter, FinityGuardian) ─────────────
pub const ORACLE_SEED: &[u8] = b"v2/oracle";
pub const GUARDIAN_SEED: &[u8] = b"v2/guardian";
pub const MAX_ORACLE_SIGNERS: usize = 8;
/// A signed price report: "FNTY" ‖ market ‖ price (u64 LE, USDC base units per token) ‖ observed_at (i64 LE).
pub const REPORT_DOMAIN: &[u8; 4] = b"FNTY";
pub const REPORT_LEN: usize = 4 + 32 + 8 + 8;
/// Freshness window: a report older than 3 min or more than 1 min ahead is rejected.
pub const DEFAULT_MAX_DELAY_SECS: i64 = 180;
pub const DEFAULT_MAX_AHEAD_SECS: i64 = 60;
pub const MAX_HAIRCUT_SECS: i64 = 7 * 24 * 3600;
pub const NO_AUTOCOVER_SEED: &[u8] = b"v2/no_autocover";
