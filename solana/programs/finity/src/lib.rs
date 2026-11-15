//! Finity Finance on Solana: borrow USDC against tokenized stocks and a T-Bill fund, funded by a senior
//! lender vault. Market-hours aware: while a market is closed or halted, borrowing is capped at its
//! closure-safe LTV. All risk math is checked bit-for-bit against the reference crate in `reference/risk-core`.

pub mod clock;
pub mod constants;
pub mod error;
pub mod instructions;
pub mod math;
pub mod risk;
pub mod state;
pub mod vault_markets;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("9GUKJUTYMZpvRhkfQyvVZ3j1Y8rcjKPfwJ5ovmfU9bY1");

#[program]
pub mod finity {
    use super::*;

    // ── admin / keeper ──

    pub fn initialize(ctx: Context<Initialize>, keeper: Pubkey) -> Result<()> {
        instructions::admin::handle_initialize(ctx, keeper)
    }

    pub fn init_market(ctx: Context<InitMarket>, params: InitMarketParams) -> Result<()> {
        instructions::admin::handle_init_market(ctx, params)
    }

    pub fn admin_mint(ctx: Context<AdminMint>, amount: u64) -> Result<()> {
        instructions::admin::handle_admin_mint(ctx, amount)
    }

    pub fn set_price(ctx: Context<KeeperUpdate>, price: u64) -> Result<()> {
        instructions::admin::handle_set_price(ctx, price)
    }

    pub fn allocate(ctx: Context<Allocate>, assets: u64) -> Result<()> {
        instructions::admin::handle_allocate(ctx, assets)
    }

    pub fn deallocate(ctx: Context<Allocate>, assets: u64) -> Result<()> {
        instructions::admin::handle_deallocate(ctx, assets)
    }

    pub fn set_queues(ctx: Context<SetVaultConfig>, supply_queue: Vec<u8>, withdraw_queue: Vec<u8>) -> Result<()> {
        instructions::admin::handle_set_queues(ctx, supply_queue, withdraw_queue)
    }

    pub fn set_vault_cap(ctx: Context<SetVaultConfig>, index: u8, cap: u64) -> Result<()> {
        instructions::admin::handle_set_vault_cap(ctx, index, cap)
    }

    // ── signed prices and the guardian ──

    pub fn set_oracle(ctx: Context<SetOracle>, signers: Vec<Pubkey>, threshold: u8, keeper_price_allowed: bool) -> Result<()> {
        instructions::oracle_ix::handle_set_oracle(ctx, signers, threshold, keeper_price_allowed)
    }

    pub fn submit_prices(ctx: Context<SubmitPrices>) -> Result<()> {
        instructions::oracle_ix::handle_submit_prices(ctx)
    }

    pub fn set_guardian(ctx: Context<InitGuardian>, guardian: Pubkey) -> Result<()> {
        instructions::oracle_ix::handle_set_guardian(ctx, guardian)
    }

    pub fn guardian_pause(ctx: Context<GuardianAct>, borrow_paused: bool, cover_paused: bool) -> Result<()> {
        instructions::oracle_ix::handle_guardian_pause(ctx, borrow_paused, cover_paused)
    }

    pub fn guardian_haircut(ctx: Context<GuardianAct>, haircut_bps: u16, until: i64) -> Result<()> {
        instructions::oracle_ix::handle_guardian_haircut(ctx, haircut_bps, until)
    }

    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::oracle_ix::handle_set_admin(ctx, new_admin)
    }

    // ── market clock and risk engine ──

    pub fn init_calendar(ctx: Context<InitCalendar>, venue: [u8; 8]) -> Result<()> {
        instructions::clock_ix::handle_init_calendar(ctx, venue)
    }

    pub fn append_sessions(ctx: Context<AppendSessions>, sessions: Vec<SessionArg>) -> Result<()> {
        instructions::clock_ix::handle_append_sessions(ctx, sessions)
    }

    pub fn init_clock(ctx: Context<InitClock>) -> Result<()> {
        instructions::clock_ix::handle_init_clock(ctx)
    }

    pub fn poke(ctx: Context<Poke>) -> Result<()> {
        instructions::clock_ix::handle_poke(ctx)
    }

    pub fn restrict(ctx: Context<Guardian>, state: ClockState, until: i64) -> Result<()> {
        instructions::clock_ix::handle_restrict(ctx, state, until)
    }

    pub fn set_corporate_action(ctx: Context<Guardian>, active: bool) -> Result<()> {
        instructions::clock_ix::handle_set_corporate_action(ctx, active)
    }

    pub fn set_risk_config(ctx: Context<SetRiskConfig>, params: RiskConfigParams, sigma_oracle: Pubkey) -> Result<()> {
        instructions::clock_ix::handle_set_risk_config(ctx, params, sigma_oracle)
    }

    pub fn set_scenario_set(
        ctx: Context<SetScenarioSet>,
        closure_type: u8,
        n: u32,
        scenario_hash: [u8; 32],
        z_tail: Vec<i16>,
        sigma: u64,
        sigma_floor: u64,
    ) -> Result<()> {
        instructions::clock_ix::handle_set_scenario_set(ctx, closure_type, n, scenario_hash, z_tail, sigma, sigma_floor)
    }

    pub fn set_sigma_floor(ctx: Context<SetScenarioSet>, closure_type: u8, floor: u64) -> Result<()> {
        instructions::clock_ix::handle_set_sigma_floor(ctx, closure_type, floor)
    }

    pub fn update_sigma(ctx: Context<UpdateSigma>, sigma: u64) -> Result<()> {
        instructions::clock_ix::handle_update_sigma(ctx, sigma)
    }

    pub fn faucet(ctx: Context<Faucet>, amount: u64) -> Result<()> {
        instructions::faucet::handle_faucet(ctx, amount)
    }

    // ── borrowers ──

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::user::handle_deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::user::handle_withdraw(ctx, amount)
    }

    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        instructions::user::handle_borrow(ctx, amount)
    }

    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        instructions::user::handle_repay(ctx, amount)
    }

    // Liquidations go through auctions only (P5: being fastest earns nothing).

    pub fn flag(ctx: Context<Flag>, kind: u8, auction_id: u64) -> Result<()> {
        instructions::auction_ix::handle_flag(ctx, kind, auction_id)
    }

    pub fn fix_position(ctx: Context<FixPosition>) -> Result<()> {
        instructions::auction_ix::handle_fix_position(ctx)
    }

    pub fn place_bid(ctx: Context<PlaceBid>, qty: u64, price: u64) -> Result<()> {
        instructions::auction_ix::handle_place_bid(ctx, qty, price)
    }

    pub fn commit_bid(ctx: Context<PlaceBid>, commitment: [u8; 32], max_notional: u64) -> Result<()> {
        instructions::auction_ix::handle_commit_bid(ctx, commitment, max_notional)
    }

    pub fn reveal_bid(ctx: Context<PlaceBid>, qty: u64, price: u64, salt: [u8; 32]) -> Result<()> {
        instructions::auction_ix::handle_reveal_bid(ctx, qty, price, salt)
    }

    pub fn clear_auction<'info>(ctx: Context<'info, ClearAuction<'info>>) -> Result<()> {
        instructions::auction_ix::handle_clear_auction(ctx)
    }

    // ── backstop inventory: GDA resale and T-Bill redemptions (F-4.5e, §8.8) ──

    pub fn close_epoch_market(ctx: Context<CloseEpochMarket>) -> Result<()> {
        instructions::pool_ix::handle_close_epoch_market(ctx)
    }

    pub fn mark_inventory(ctx: Context<MarkInventory>) -> Result<()> {
        instructions::inventory_ix::handle_mark_inventory(ctx)
    }

    pub fn resell_inventory(ctx: Context<ResellInventory>) -> Result<()> {
        instructions::inventory_ix::handle_resell_inventory(ctx)
    }

    pub fn gda_buy(ctx: Context<GdaBuy>, qty: u64, max_cost: u64) -> Result<()> {
        instructions::inventory_ix::handle_gda_buy(ctx, qty, max_cost)
    }

    pub fn close_gda(ctx: Context<CloseGda>) -> Result<()> {
        instructions::inventory_ix::handle_close_gda(ctx)
    }

    pub fn request_redemption(ctx: Context<RequestRedemption>) -> Result<()> {
        instructions::inventory_ix::handle_request_redemption(ctx)
    }

    pub fn claim_redemption(ctx: Context<ClaimRedemption>) -> Result<()> {
        instructions::inventory_ix::handle_claim_redemption(ctx)
    }

    pub fn migrate_pool(ctx: Context<MigratePool>) -> Result<()> {
        instructions::inventory_ix::handle_migrate_pool(ctx)
    }

    pub fn settle_lot_position(ctx: Context<SettleLotPosition>) -> Result<()> {
        instructions::auction_ix::handle_settle_lot_position(ctx)
    }

    pub fn claim_bid(ctx: Context<ClaimBid>) -> Result<()> {
        instructions::auction_ix::handle_claim_bid(ctx)
    }

    pub fn complete_reopen(ctx: Context<CompleteReopen>) -> Result<()> {
        instructions::auction_ix::handle_complete_reopen(ctx)
    }

    // ── underwriter pool, Gap Cover, reserve ──

    pub fn init_pool(ctx: Context<InitPool>, venue: [u8; 8]) -> Result<()> {
        instructions::pool_ix::handle_init_pool(ctx, venue)
    }

    pub fn init_reserve(ctx: Context<InitReserve>) -> Result<()> {
        instructions::pool_ix::handle_init_reserve(ctx)
    }

    pub fn add_pool_market(ctx: Context<AddPoolMarket>) -> Result<()> {
        instructions::pool_ix::handle_add_pool_market(ctx)
    }

    pub fn set_joint_column(ctx: Context<SetJointColumn>, hash: [u8; 32], z: Vec<i16>) -> Result<()> {
        instructions::pool_ix::handle_set_joint_column(ctx, hash, z)
    }

    pub fn pool_deposit(ctx: Context<PoolDeposit>, assets: u64) -> Result<()> {
        instructions::pool_ix::handle_pool_deposit(ctx, assets)
    }

    pub fn pool_deposit_queued(ctx: Context<PoolDepositQueued>, assets: u64) -> Result<()> {
        instructions::pool_ix::handle_pool_deposit_queued(ctx, assets)
    }

    pub fn pool_request_withdraw(ctx: Context<PoolRequestWithdraw>, shares: u64) -> Result<()> {
        instructions::pool_ix::handle_pool_request_withdraw(ctx, shares)
    }

    pub fn pool_claim(ctx: Context<PoolClaim>, seq: u64) -> Result<()> {
        instructions::pool_ix::handle_pool_claim(ctx, seq)
    }

    pub fn open_epoch(ctx: Context<OpenEpoch>) -> Result<()> {
        instructions::pool_ix::handle_open_epoch(ctx)
    }

    pub fn snapshot_epoch(ctx: Context<SnapshotEpoch>) -> Result<()> {
        instructions::pool_ix::handle_snapshot_epoch(ctx)
    }

    pub fn init_epoch_market(ctx: Context<InitEpochMarket>) -> Result<()> {
        instructions::pool_ix::handle_init_epoch_market(ctx)
    }

    pub fn refresh_capacity(ctx: Context<RefreshCapacity>) -> Result<()> {
        instructions::pool_ix::handle_refresh_capacity(ctx)
    }

    pub fn settle_epoch<'info>(ctx: Context<'info, SettleEpoch<'info>>) -> Result<()> {
        instructions::pool_ix::handle_settle_epoch(ctx)
    }

    pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
        instructions::pool_ix::handle_sweep_fees(ctx)
    }

    pub fn write_cover(ctx: Context<WriteCover>, max_premium: u64, add_to_debt: bool, auto: bool) -> Result<()> {
        instructions::cover_ix::handle_write_cover(ctx, max_premium, add_to_debt, auto)
    }

    pub fn set_auto_cover(ctx: Context<SetAutoCover>, enabled: bool) -> Result<()> {
        instructions::cover_ix::handle_set_auto_cover(ctx, enabled)
    }

    // ── senior lenders ──

    pub fn lend_deposit<'info>(ctx: Context<'info, LendDeposit<'info>>, assets: u64) -> Result<()> {
        instructions::lend::handle_lend_deposit(ctx, assets)
    }

    pub fn lend_redeem<'info>(ctx: Context<'info, LendRedeem<'info>>, shares: u64) -> Result<()> {
        instructions::lend::handle_lend_redeem(ctx, shares)
    }

    pub fn request_redeem(ctx: Context<RequestRedeem>, shares: u64) -> Result<()> {
        instructions::lend::handle_request_redeem(ctx, shares)
    }

    pub fn process_redeem_queue<'info>(ctx: Context<'info, ProcessRedeemQueue<'info>>) -> Result<()> {
        instructions::lend::handle_process_redeem_queue(ctx)
    }

    pub fn claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
        instructions::lend::handle_claim_redeem(ctx)
    }
}
