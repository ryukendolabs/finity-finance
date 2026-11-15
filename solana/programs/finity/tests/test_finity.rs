use {
    anchor_lang::{
        prelude::{AccountMeta, Pubkey},
        solana_program::{clock::Clock, instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::associated_token::{get_associated_token_address, ID as ATA_PROGRAM_ID},
    finity::{accounts as acc, constants::*, instruction as ix, state::*, InitMarketParams},
    finity::state::{ClockState, RiskConfigParams, SessionArg},
    litesvm::LiteSVM,
    litesvm_token::{get_spl_account, spl_token, CreateMint, TOKEN_ID},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const ONE: u64 = 1_000_000; // 6-decimal unit, used for both the stock and USDC
const WAD: u64 = 1_000_000_000_000_000_000;
const T0: i64 = 1_800_000_000;
const YEAR: i64 = 365 * 24 * 3600;
const H: i64 = 3600;
const COMPUTE_BUDGET: Pubkey = anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");
const VENUE: [u8; 8] = *b"TESTVENU";

/// Test calendar: T0 sits inside a regular session (open T0−1h, close T0+5h, so the Bell window opens at T0+3h),
/// then daily sessions; the third close is a weekend.
fn sessions() -> Vec<SessionArg> {
    (0..5i64)
        .map(|d| {
            let o = T0 - H + d * 24 * H;
            SessionArg {
                ext_open: (o - 2 * H) as u32,
                open: o as u32,
                close: (o + 6 * H) as u32,
                ext_close: (o + 7 * H) as u32,
                closure_type_after: if d == 2 { CLOSURE_WEEKEND } else { CLOSURE_OVERNIGHT },
            }
        })
        .collect()
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    keeper: Keypair,
    config: Pubkey,
    senior: Pubkey,
    share_mint: Pubkey,
    usdc_mint: Pubkey,
    usdc_vault: Pubkey,
    stock_mint: Pubkey,
    market: Pubkey,
    vault: Pubkey,
    calendar: Pubkey,
    clock: Pubkey,
    venue: [u8; 8],
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &finity::id()).0
}

impl Env {
    /// One AAPL-like market at 200 USDC (60% / 40% closed / 75% liquidation, 5% bonus) and `liquidity` USDC
    /// deposited into the senior vault by the admin.
    fn new() -> Self {
        Self::with_liquidity(1_000_000 * ONE)
    }

    fn with_liquidity(liquidity: u64) -> Self {
        Self::build(liquidity, T0)
    }

    /// Everything set up at `start` (the calendar is fixed around T0).
    fn build(liquidity: u64, start: i64) -> Self {
        Self::build_venue(liquidity, start, VENUE)
    }

    /// The same on another venue calendar (USBANK = the T-Bill fund rules).
    fn build_venue(liquidity: u64, start: i64, venue: [u8; 8]) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(finity::id(), include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/finity.so")))
            .unwrap();
        let admin = Keypair::new();
        let keeper = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
        set_time(&mut svm, start);

        let config = pda(&[CONFIG_SEED]);
        let usdc_vault = pda(&[USDC_VAULT_SEED]);
        let senior = pda(&[SENIOR_SEED]);
        let share_mint = pda(&[SHARE_MINT_SEED]);
        let usdc_mint = CreateMint::new(&mut svm, &admin).authority(&config).decimals(6).send().unwrap();
        let stock_mint = CreateMint::new(&mut svm, &admin).authority(&config).decimals(6).send().unwrap();
        let market = pda(&[MARKET_SEED, stock_mint.as_ref()]);
        let vault = pda(&[VAULT_SEED, market.as_ref()]);

        let calendar = pda(&[CALENDAR_SEED, &venue]);
        let clock = pda(&[CLOCK_SEED, market.as_ref()]);
        let mut env = Env { svm, admin, keeper, config, senior, share_mint, usdc_mint, usdc_vault, stock_mint, market, vault, calendar, clock, venue };
        let a = env.admin.insecure_clone();
        env.send(
            ix::Initialize { keeper: env.keeper.pubkey() }.data(),
            acc::Initialize {
                admin: a.pubkey(),
                config,
                usdc_mint,
                usdc_vault,
                senior,
                share_mint,
                share_escrow: pda(&[SHARE_ESCROW_SEED]),
                dead_shares: pda(&[DEAD_SHARES_SEED]),
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            &[&a],
        )
        .unwrap();
        env.send(
            ix::InitMarket {
                params: InitMarketParams {
                    symbol: "AAPL".into(),
                    price: 200 * ONE,
                    max_ltv_bps: 6_000,
                    closed_ltv_bps: 4_000,
                    liq_threshold_bps: 7_500,
                    liq_bonus_bps: 500,
                    rate: RateParams { r0: WAD / 50, s1: WAD * 6 / 100, s2: WAD * 8 / 10, u_kink: WAD * 9 / 10 },
                    supply_cap: 10_000_000 * ONE,
                    borrow_cap: 5_000_000 * ONE,
                    vault_cap: 10_000_000 * ONE,
                },
            }
            .data(),
            acc::InitMarket {
                admin: a.pubkey(),
                config,
                senior,
                collateral_mint: stock_mint,
                market,
                vault,
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            &[&a],
        )
        .unwrap();
        env.setup_clock_and_risk(&a);
        env.setup_pool(&a);
        if liquidity > 0 {
            env.send(
                ix::AdminMint { amount: liquidity }.data(),
                acc::AdminMint {
                    admin: a.pubkey(),
                    config,
                    usdc_mint,
                    admin_usdc: get_associated_token_address(&a.pubkey(), &usdc_mint),
                    token_program: TOKEN_ID,
                    associated_token_program: ATA_PROGRAM_ID,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                &[&a],
            )
            .unwrap();
            env.lend_deposit(&a, liquidity).unwrap();
        }
        env
    }

    fn send(&mut self, data: Vec<u8>, metas: Vec<AccountMeta>, signers: &[&Keypair]) -> Result<(), String> {
        let ix = Instruction { program_id: finity::id(), accounts: metas, data };
        // Like every client: ask for the transaction maximum (ComputeBudget SetComputeUnitLimit = 2).
        let budget = Instruction {
            program_id: COMPUTE_BUDGET,
            accounts: vec![],
            data: [&[2u8][..], &1_400_000u32.to_le_bytes()].concat(),
        };
        let payer = signers[0].pubkey();
        let msg = Message::new_with_blockhash(&[budget, ix], Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let res = self
            .svm
            .send_transaction(tx)
            .map(|m| {
                if std::env::var("CU").is_ok() {
                    println!("CU {:>8} {}", m.compute_units_consumed, m.logs.iter().find(|l| l.contains("Instruction:")).map(|l| l.as_str()).unwrap_or(""));
                }
            })
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.svm.expire_blockhash();
        res
    }

    /// Like `send`, with `pre` instructions placed before ours (e.g. Ed25519 signature checks).
    fn send_with(&mut self, pre: Vec<Instruction>, data: Vec<u8>, metas: Vec<AccountMeta>, signers: &[&Keypair]) -> Result<(), String> {
        let mut ixs = pre;
        ixs.push(Instruction { program_id: finity::id(), accounts: metas, data });
        let payer = signers[0].pubkey();
        let msg = Message::new_with_blockhash(&ixs, Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let res = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.svm.expire_blockhash();
        res
    }

    fn set_oracle(&mut self, signers: Vec<Pubkey>, threshold: u8, keeper_price_allowed: bool) -> Result<(), String> {
        let a = self.admin.insecure_clone();
        let metas = acc::SetOracle { admin: a.pubkey(), config: self.config, oracle: pda(&[ORACLE_SEED]), system_program: system_program::ID }.to_account_metas(None);
        self.send(ix::SetOracle { signers, threshold, keeper_price_allowed }.data(), metas, &[&a])
    }

    /// Submits `reports` (signer, market, price, observed_at), each signed in one Ed25519 precompile instruction.
    fn submit_prices(&mut self, reports: &[(&Keypair, Pubkey, u64, i64)]) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let pre = vec![ed25519_ix(reports)];
        let metas = acc::SubmitPrices { oracle: pda(&[ORACLE_SEED]), market: self.market, instructions: INSTRUCTIONS_SYSVAR }.to_account_metas(None);
        self.send_with(pre, ix::SubmitPrices {}.data(), metas, &[&k])
    }

    fn guardian_act(&mut self, data: Vec<u8>) -> Result<(), String> {
        let a = self.admin.insecure_clone();
        let metas = acc::GuardianAct { authority: a.pubkey(), config: self.config, guardian_state: pda(&[GUARDIAN_SEED]) }.to_account_metas(None);
        self.send(data, metas, &[&a])
    }

    fn set_auto_cover(&mut self, owner: &Keypair, enabled: bool) -> Result<(), String> {
        let metas = acc::SetAutoCover {
            owner: owner.pubkey(), market: self.market, position: self.position(&owner.pubkey()),
            opt_out: pda(&[NO_AUTOCOVER_SEED, self.position(&owner.pubkey()).as_ref()]), system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::SetAutoCover { enabled }.data(), metas, &[owner])
    }

    fn user(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        k
    }

    fn keeper_update(&mut self, data: Vec<u8>, signer: &Keypair) -> Result<(), String> {
        let metas = acc::KeeperUpdate { authority: signer.pubkey(), config: self.config, market: self.market, oracle: pda(&[ORACLE_SEED]) }.to_account_metas(None);
        self.send(data, metas, &[signer])
    }

    fn set_price(&mut self, price: u64) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        self.keeper_update(ix::SetPrice { price }.data(), &k)
    }

    /// Calendar, clock, risk config (α = 25%, κ = 0) and three risk sets whose safe LTV is exactly 40%
    /// (σ = 0.6, z at the α quantile = −1000 → g = 1 − 0.6).
    fn setup_clock_and_risk(&mut self, a: &Keypair) {
        let (config, market, calendar, clock) = (self.config, self.market, self.calendar, self.clock);
        self.send(
            ix::InitCalendar { venue: self.venue }.data(),
            acc::InitCalendar { admin: a.pubkey(), config, calendar, system_program: system_program::ID }.to_account_metas(None),
            &[a],
        )
        .unwrap();
        self.send(
            ix::AppendSessions { sessions: sessions() }.data(),
            acc::AppendSessions { admin: a.pubkey(), config, calendar }.to_account_metas(None),
            &[a],
        )
        .unwrap();
        self.send(
            ix::InitClock {}.data(),
            acc::InitClock { admin: a.pubkey(), config, market, calendar, clock, system_program: system_program::ID }
                .to_account_metas(None),
            &[a],
        )
        .unwrap();
        self.send(
            ix::SetRiskConfig {
                params: RiskConfigParams {
                    alpha: WAD / 4, beta: WAD / 1000 * 975, kappa: 0, theta: WAD, cost_of_cap: WAD * 15 / 100,
                    eta: 4 * WAD, min_premium: 500_000, u_max: WAD / 2, k_stress: 256,
                },
                sigma_oracle: self.keeper.pubkey(),
            }
            .data(),
            acc::SetRiskConfig { admin: a.pubkey(), config, risk_config: pda(&[RISK_CONFIG_SEED]), system_program: system_program::ID }
                .to_account_metas(None),
            &[a],
        )
        .unwrap();
        for t in [CLOSURE_OVERNIGHT, CLOSURE_WEEKEND, CLOSURE_HOLIDAY_WEEKEND] {
            self.send(
                ix::SetScenarioSet {
                    closure_type: t, n: 4, scenario_hash: [t; 32], z_tail: vec![-1000, -500, 0, 500],
                    sigma: WAD * 6 / 10, sigma_floor: WAD / 10,
                }
                .data(),
                acc::SetScenarioSet { admin: a.pubkey(), config, market, risk_set: self.risk_set(t), system_program: system_program::ID }
                    .to_account_metas(None),
                &[a],
            )
            .unwrap();
        }
    }

    /// Pool, reserve and joint column (z_j = −1000 + 8j: from 1.67σ down to 1.04σ up).
    fn setup_pool(&mut self, a: &Keypair) {
        let (config, market, calendar, clock) = (self.config, self.market, self.calendar, self.clock);
        let pool = self.pool();
        self.send(
            ix::InitPool { venue: self.venue }.data(),
            acc::InitPool {
                admin: a.pubkey(), config, calendar, pool, share_mint: pda(&[POOL_SHARES_SEED, &self.venue]),
                escrow: pda(&[POOL_ESCROW_SEED, &self.venue]), token_program: TOKEN_ID, system_program: system_program::ID,
            }
            .to_account_metas(None),
            &[a],
        )
        .unwrap();
        self.send(
            ix::InitReserve {}.data(),
            acc::InitReserve { admin: a.pubkey(), config, reserve: pda(&[RESERVE_SEED]), system_program: system_program::ID }.to_account_metas(None),
            &[a],
        )
        .unwrap();
        self.send(
            ix::AddPoolMarket {}.data(),
            acc::AddPoolMarket { admin: a.pubkey(), config, pool, market, clock }.to_account_metas(None),
            &[a],
        )
        .unwrap();
        let z: Vec<i16> = (0..256).map(|j| -1000 + 8 * j as i16).collect();
        self.send(
            ix::SetJointColumn { hash: [7; 32], z }.data(),
            acc::SetJointColumn { admin: a.pubkey(), config, market, joint: pda(&[JOINT_SEED, market.as_ref()]), system_program: system_program::ID }
                .to_account_metas(None),
            &[a],
        )
        .unwrap();
    }

    fn pool(&self) -> Pubkey {
        pda(&[POOL_SEED, &self.venue])
    }

    fn pool_shares(&self) -> Pubkey {
        pda(&[POOL_SHARES_SEED, &self.venue])
    }

    fn epoch(&self, seq: u64) -> Pubkey {
        pda(&[EPOCH_SEED, self.pool().as_ref(), &seq.to_le_bytes()])
    }

    fn epoch_market(&self, seq: u64) -> Pubkey {
        pda(&[EPOCH_MARKET_SEED, self.epoch(seq).as_ref(), self.market.as_ref()])
    }

    fn policy(&self, owner: &Pubkey, closure_id: u64) -> Pubkey {
        pda(&[POLICY_SEED, self.market.as_ref(), owner.as_ref(), &closure_id.to_le_bytes()])
    }

    fn get_pool(&self) -> UnderwriterPool {
        let a = self.svm.get_account(&self.pool()).unwrap();
        UnderwriterPool::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn get_epoch(&self, seq: u64) -> Epoch {
        let a = self.svm.get_account(&self.epoch(seq)).unwrap();
        *bytemuck::from_bytes::<Epoch>(&a.data[8..8 + std::mem::size_of::<Epoch>()])
    }

    fn get_policy(&self, owner: &Pubkey, closure_id: u64) -> Policy {
        let a = self.svm.get_account(&self.policy(owner, closure_id)).unwrap();
        Policy::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn pool_deposit(&mut self, user: &Keypair, assets: u64) -> Result<(), String> {
        let metas = acc::PoolDeposit {
            owner: user.pubkey(), config: self.config, pool: self.pool(), usdc_mint: self.usdc_mint, share_mint: self.pool_shares(),
            owner_usdc: get_associated_token_address(&user.pubkey(), &self.usdc_mint),
            owner_shares: get_associated_token_address(&user.pubkey(), &self.pool_shares()),
            usdc_vault: self.usdc_vault, token_program: TOKEN_ID, associated_token_program: ATA_PROGRAM_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::PoolDeposit { assets }.data(), metas, &[user])
    }

    fn pool_deposit_queued(&mut self, user: &Keypair, assets: u64) -> Result<(), String> {
        let seq = self.get_pool().epochs_opened;
        let metas = acc::PoolDepositQueued {
            owner: user.pubkey(), config: self.config, pool: self.pool(), epoch: self.epoch(seq),
            ticket: pda(&[POOL_TICKET_SEED, self.pool().as_ref(), user.pubkey().as_ref(), &seq.to_le_bytes()]),
            owner_usdc: get_associated_token_address(&user.pubkey(), &self.usdc_mint), usdc_vault: self.usdc_vault,
            token_program: TOKEN_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::PoolDepositQueued { assets }.data(), metas, &[user])
    }

    fn pool_request_withdraw(&mut self, user: &Keypair, shares: u64) -> Result<(), String> {
        let seq = self.get_pool().epochs_opened + 1;
        let metas = acc::PoolRequestWithdraw {
            owner: user.pubkey(), pool: self.pool(), share_mint: self.pool_shares(),
            owner_shares: get_associated_token_address(&user.pubkey(), &self.pool_shares()),
            escrow: pda(&[POOL_ESCROW_SEED, &self.venue]),
            ticket: pda(&[POOL_TICKET_SEED, self.pool().as_ref(), user.pubkey().as_ref(), &seq.to_le_bytes()]),
            token_program: TOKEN_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::PoolRequestWithdraw { shares }.data(), metas, &[user])
    }

    fn pool_claim(&mut self, user: &Keypair, seq: u64) -> Result<(), String> {
        let metas = acc::PoolClaim {
            owner: user.pubkey(), config: self.config, pool: self.pool(), epoch: self.epoch(seq),
            ticket: pda(&[POOL_TICKET_SEED, self.pool().as_ref(), user.pubkey().as_ref(), &seq.to_le_bytes()]),
            usdc_mint: self.usdc_mint, share_mint: self.pool_shares(), escrow: pda(&[POOL_ESCROW_SEED, &self.venue]),
            owner_shares: get_associated_token_address(&user.pubkey(), &self.pool_shares()),
            owner_usdc: get_associated_token_address(&user.pubkey(), &self.usdc_mint),
            usdc_vault: self.usdc_vault, token_program: TOKEN_ID, associated_token_program: ATA_PROGRAM_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::PoolClaim { seq }.data(), metas, &[user])
    }

    /// Opens the next epoch and its market account, then refreshes capacity.
    fn open_epoch(&mut self) -> Result<u64, String> {
        let k = self.keeper.insecure_clone();
        let seq = self.get_pool().epochs_opened + 1;
        self.send(
            ix::OpenEpoch {}.data(),
            acc::OpenEpoch { cranker: k.pubkey(), pool: self.pool(), calendar: self.calendar, epoch: self.epoch(seq), system_program: system_program::ID }
                .to_account_metas(None),
            &[&k],
        )?;
        self.send(
            ix::InitEpochMarket {}.data(),
            acc::InitEpochMarket {
                cranker: k.pubkey(), pool: self.pool(), epoch: self.epoch(seq), market: self.market,
                epoch_market: self.epoch_market(seq), system_program: system_program::ID,
            }
            .to_account_metas(None),
            &[&k],
        )?;
        self.refresh_capacity(seq)?;
        Ok(seq)
    }

    fn refresh_capacity(&mut self, seq: u64) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let t = self.get_epoch(seq).closure_type;
        let metas = acc::RefreshCapacity {
            pool: self.pool(), epoch: self.epoch(seq), epoch_market: self.epoch_market(seq), market: self.market,
            risk_config: pda(&[RISK_CONFIG_SEED]), risk_set: self.risk_set(t), joint: pda(&[JOINT_SEED, self.market.as_ref()]),
        }
        .to_account_metas(None);
        self.send(ix::RefreshCapacity {}.data(), metas, &[&k])
    }

    fn snapshot_epoch(&mut self) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let seq = self.get_pool().epochs_opened;
        let metas = acc::SnapshotEpoch { pool: self.pool(), epoch: self.epoch(seq) }.to_account_metas(None);
        self.send(ix::SnapshotEpoch {}.data(), metas, &[&k])
    }

    fn settle_epoch(&mut self) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let seq = self.get_pool().epochs_opened;
        let mut metas = acc::SettleEpoch {
            pool: self.pool(), epoch: self.epoch(seq), share_mint: self.pool_shares(), escrow: pda(&[POOL_ESCROW_SEED, &self.venue]), token_program: TOKEN_ID,
        }
        .to_account_metas(None);
        metas.push(AccountMeta::new_readonly(self.clock, false));
        self.send(ix::SettleEpoch {}.data(), metas, &[&k])
    }

    fn sweep_fees(&mut self) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::SweepFees { senior: self.senior, market: self.market, pool: self.pool(), reserve: pda(&[RESERVE_SEED]) }.to_account_metas(None);
        self.send(ix::SweepFees {}.data(), metas, &[&k])
    }

    /// Buys cover (`auto = false`, signed by the borrower) or enforces the Bell (`auto = true`, signed by the keeper).
    fn write_cover(&mut self, owner: &Keypair, max_premium: u64, add_to_debt: bool, auto: bool) -> Result<(), String> {
        let signer = if auto { self.keeper.insecure_clone() } else { owner.insecure_clone() };
        let seq = self.get_pool().epochs_opened;
        let c = self.get_clock();
        let metas = acc::WriteCover {
            payer: signer.pubkey(), config: self.config, senior: self.senior, market: self.market, position: self.position(&owner.pubkey()),
            clock: self.clock, calendar: self.calendar, risk_config: pda(&[RISK_CONFIG_SEED]), risk_set: self.risk_set(c.next_closure_type),
            joint: pda(&[JOINT_SEED, self.market.as_ref()]), pool: self.pool(), epoch: self.epoch(seq), epoch_market: self.epoch_market(seq),
            policy: self.policy(&owner.pubkey(), c.closure_id + 1),
            guardian_state: pda(&[GUARDIAN_SEED]),
            opt_out: pda(&[NO_AUTOCOVER_SEED, self.position(&owner.pubkey()).as_ref()]),
            owner_usdc: if add_to_debt || auto { None } else { Some(get_associated_token_address(&owner.pubkey(), &self.usdc_mint)) },
            usdc_vault: self.usdc_vault, token_program: TOKEN_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::WriteCover { max_premium, add_to_debt, auto }.data(), metas, &[&signer])
    }

    fn risk_set(&self, t: u8) -> Pubkey {
        pda(&[RISK_SET_SEED, self.market.as_ref(), &[t]])
    }

    fn poke(&mut self) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::Poke { market: self.market, clock: self.clock, calendar: self.calendar }.to_account_metas(None);
        self.send(ix::Poke {}.data(), metas, &[&k])
    }

    fn restrict(&mut self, state: ClockState, until: i64) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::Guardian { authority: k.pubkey(), config: self.config, market: self.market, clock: self.clock, calendar: self.calendar }
            .to_account_metas(None);
        self.send(ix::Restrict { state, until }.data(), metas, &[&k])
    }

    fn update_sigma(&mut self, t: u8, sigma: u64) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::UpdateSigma { authority: k.pubkey(), config: self.config, risk_config: pda(&[RISK_CONFIG_SEED]), risk_set: self.risk_set(t) }
            .to_account_metas(None);
        self.send(ix::UpdateSigma { sigma }.data(), metas, &[&k])
    }

    fn get_clock(&self) -> AssetClock {
        let a = self.svm.get_account(&self.clock).unwrap();
        AssetClock::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn get_risk_set(&self, t: u8) -> RiskSet {
        let a = self.svm.get_account(&self.risk_set(t)).unwrap();
        RiskSet::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    /// Moves time to `ts`, pushes a fresh price and pokes the clock.
    fn at(&mut self, ts: i64) {
        set_time(&mut self.svm, ts);
        let p = self.get_market().price;
        self.set_price(p).unwrap();
        self.poke().unwrap();
    }

    fn faucet(&mut self, user: &Keypair, mint: Pubkey, amount: u64) -> Result<(), String> {
        let metas = acc::Faucet {
            user: user.pubkey(),
            config: self.config,
            mint,
            user_token: get_associated_token_address(&user.pubkey(), &mint),
            token_program: TOKEN_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::Faucet { amount }.data(), metas, &[user])
    }

    fn faucet_usdc(&mut self, user: &Keypair, mut amount: u64) {
        let mint = self.usdc_mint;
        while amount > 0 {
            let a = amount.min(FAUCET_MAX_WHOLE * ONE);
            self.faucet(user, mint, a).unwrap();
            amount -= a;
        }
    }

    fn position(&self, owner: &Pubkey) -> Pubkey {
        pda(&[POSITION_SEED, self.market.as_ref(), owner.as_ref()])
    }

    fn deposit(&mut self, user: &Keypair, amount: u64) -> Result<(), String> {
        let metas = acc::Deposit {
            owner: user.pubkey(),
            market: self.market,
            position: self.position(&user.pubkey()),
            owner_collateral: get_associated_token_address(&user.pubkey(), &self.stock_mint),
            vault: self.vault,
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::Deposit { amount }.data(), metas, &[user])
    }

    fn withdraw(&mut self, user: &Keypair, amount: u64) -> Result<(), String> {
        let metas = acc::Withdraw {
            owner: user.pubkey(),
            senior: self.senior,
            market: self.market,
            position: self.position(&user.pubkey()),
            clock: self.clock,
            calendar: self.calendar,
            risk_config: pda(&[RISK_CONFIG_SEED]),
            risk_overnight: self.risk_set(CLOSURE_OVERNIGHT),
            risk_weekend: self.risk_set(CLOSURE_WEEKEND),
            risk_holiday: self.risk_set(CLOSURE_HOLIDAY_WEEKEND),
            policy: None,
            guardian_state: pda(&[GUARDIAN_SEED]),
            owner_collateral: get_associated_token_address(&user.pubkey(), &self.stock_mint),
            vault: self.vault,
            token_program: TOKEN_ID,
        }
        .to_account_metas(None);
        self.send(ix::Withdraw { amount }.data(), metas, &[user])
    }

    fn borrow(&mut self, user: &Keypair, amount: u64) -> Result<(), String> {
        self.borrow_with(user, amount, None)
    }

    fn borrow_with(&mut self, user: &Keypair, amount: u64, policy: Option<Pubkey>) -> Result<(), String> {
        let metas = acc::Borrow {
            owner: user.pubkey(),
            config: self.config,
            senior: self.senior,
            market: self.market,
            position: self.position(&user.pubkey()),
            clock: self.clock,
            calendar: self.calendar,
            risk_config: pda(&[RISK_CONFIG_SEED]),
            risk_overnight: self.risk_set(CLOSURE_OVERNIGHT),
            risk_weekend: self.risk_set(CLOSURE_WEEKEND),
            risk_holiday: self.risk_set(CLOSURE_HOLIDAY_WEEKEND),
            policy,
            guardian_state: pda(&[GUARDIAN_SEED]),
            usdc_mint: self.usdc_mint,
            owner_usdc: get_associated_token_address(&user.pubkey(), &self.usdc_mint),
            usdc_vault: self.usdc_vault,
            token_program: TOKEN_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::Borrow { amount }.data(), metas, &[user])
    }

    fn repay(&mut self, user: &Keypair, amount: u64) -> Result<(), String> {
        let metas = acc::Repay {
            owner: user.pubkey(),
            config: self.config,
            senior: self.senior,
            market: self.market,
            position: self.position(&user.pubkey()),
            owner_usdc: get_associated_token_address(&user.pubkey(), &self.usdc_mint),
            usdc_vault: self.usdc_vault,
            token_program: TOKEN_ID,
        }
        .to_account_metas(None);
        self.send(ix::Repay { amount }.data(), metas, &[user])
    }

    // ── auctions ──

    fn auction(&self, id: u64) -> Pubkey {
        pda(&[AUCTION_SEED, self.market.as_ref(), &id.to_le_bytes()])
    }

    fn entry(&self, id: u64, owner: &Pubkey) -> Pubkey {
        pda(&[LOT_ENTRY_SEED, self.auction(id).as_ref(), owner.as_ref()])
    }

    fn bid_pda(&self, id: u64, bidder: &Pubkey) -> Pubkey {
        pda(&[BID_SEED, self.auction(id).as_ref(), bidder.as_ref()])
    }

    fn get_auction(&self, id: u64) -> Auction {
        let a = self.svm.get_account(&self.auction(id)).unwrap();
        Auction::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn get_bid(&self, id: u64, bidder: &Pubkey) -> Bid {
        let a = self.svm.get_account(&self.bid_pda(id, bidder)).unwrap();
        Bid::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn flag(&mut self, kind: u8, owner: &Pubkey, id: u64) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let c = self.get_clock();
        let t = if kind == KIND_PRECLOSE { c.next_closure_type } else { CLOSURE_OVERNIGHT };
        let metas = acc::Flag {
            cranker: k.pubkey(), senior: self.senior, market: self.market, position: self.position(owner), clock: self.clock,
            calendar: self.calendar, risk_config: pda(&[RISK_CONFIG_SEED]), risk_set: self.risk_set(t),
            policy: self.policy(owner, if kind == KIND_EMERGENCY { c.closure_id } else { c.closure_id + 1 }), opt_out: pda(&[NO_AUTOCOVER_SEED, self.position(owner).as_ref()]),
            book: pda(&[AUCTION_BOOK_SEED, self.market.as_ref()]),
            auction: self.auction(id), entry: self.entry(id, owner),
            lock: pda(&[LOCK_SEED, self.position(owner).as_ref()]), system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::Flag { kind, auction_id: id }.data(), metas, &[&k])
    }

    fn fix(&mut self, owner: &Pubkey, id: u64) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::FixPosition {
            senior: self.senior, market: self.market, position: self.position(owner), clock: self.clock,
            risk_config: pda(&[RISK_CONFIG_SEED]), auction: self.auction(id), entry: self.entry(id, owner),
        }
        .to_account_metas(None);
        self.send(ix::FixPosition {}.data(), metas, &[&k])
    }

    fn bid_metas(&self, id: u64, bidder: &Keypair) -> Vec<AccountMeta> {
        acc::PlaceBid {
            bidder: bidder.pubkey(), config: self.config, market: self.market, auction: self.auction(id),
            bid: self.bid_pda(id, &bidder.pubkey()), bidder_usdc: get_associated_token_address(&bidder.pubkey(), &self.usdc_mint),
            usdc_vault: self.usdc_vault, token_program: TOKEN_ID, system_program: system_program::ID,
        }
        .to_account_metas(None)
    }

    fn place_bid(&mut self, bidder: &Keypair, id: u64, qty: u64, price: u64) -> Result<(), String> {
        let metas = self.bid_metas(id, bidder);
        self.send(ix::PlaceBid { qty, price }.data(), metas, &[bidder])
    }

    fn commit_bid(&mut self, bidder: &Keypair, id: u64, qty: u64, price: u64, salt: [u8; 32], max_notional: u64) -> Result<(), String> {
        let c = finity::instructions::auction_ix::commitment(&self.auction(id), &bidder.pubkey(), qty, price, &salt);
        let metas = self.bid_metas(id, bidder);
        self.send(ix::CommitBid { commitment: c, max_notional }.data(), metas, &[bidder])
    }

    fn reveal_bid(&mut self, bidder: &Keypair, id: u64, qty: u64, price: u64, salt: [u8; 32]) -> Result<(), String> {
        let metas = self.bid_metas(id, bidder);
        self.send(ix::RevealBid { qty, price, salt }.data(), metas, &[bidder])
    }

    fn clear(&mut self, id: u64, bidders: &[Pubkey]) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let mut metas = acc::ClearAuction {
            cranker: k.pubkey(), config: self.config, market: self.market, risk_config: pda(&[RISK_CONFIG_SEED]),
            auction: self.auction(id), pool: self.pool(), collateral_mint: self.stock_mint, vault: self.vault,
            inventory: get_associated_token_address(&self.pool(), &self.stock_mint), inventory_state: self.inventory(),
            token_program: TOKEN_ID, associated_token_program: ATA_PROGRAM_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        metas.extend(bidders.iter().map(|b| AccountMeta::new(self.bid_pda(id, b), false)));
        self.send(ix::ClearAuction {}.data(), metas, &[&k])
    }

    fn settle_lot(&mut self, owner: &Pubkey, id: u64) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::SettleLotPosition {
            cranker: k.pubkey(), config: self.config, senior: self.senior, market: self.market, position: self.position(owner),
            auction: self.auction(id), entry: self.entry(id, owner), lock: pda(&[LOCK_SEED, self.position(owner).as_ref()]),
            pool: self.pool(), reserve: pda(&[RESERVE_SEED]), usdc_mint: self.usdc_mint,
            owner_usdc: get_associated_token_address(owner, &self.usdc_mint), owner: *owner, usdc_vault: self.usdc_vault,
            token_program: TOKEN_ID, associated_token_program: ATA_PROGRAM_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::SettleLotPosition {}.data(), metas, &[&k])
    }

    fn claim_bid(&mut self, bidder: &Keypair, id: u64) -> Result<(), String> {
        let metas = acc::ClaimBid {
            bidder: bidder.pubkey(), config: self.config, market: self.market, auction: self.auction(id), bid: self.bid_pda(id, &bidder.pubkey()),
            usdc_mint: self.usdc_mint, collateral_mint: self.stock_mint, vault: self.vault,
            bidder_collateral: get_associated_token_address(&bidder.pubkey(), &self.stock_mint),
            bidder_usdc: get_associated_token_address(&bidder.pubkey(), &self.usdc_mint),
            usdc_vault: self.usdc_vault, token_program: TOKEN_ID, associated_token_program: ATA_PROGRAM_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::ClaimBid {}.data(), metas, &[bidder])
    }

    fn complete_reopen(&mut self) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let book = pda(&[AUCTION_BOOK_SEED, self.market.as_ref()]);
        let id = self.svm.get_account(&book).map(|a| AuctionBook::try_deserialize(&mut a.data.as_slice()).unwrap().reopen).unwrap_or(0);
        let metas = acc::CompleteReopen { market: self.market, clock: self.clock, calendar: self.calendar, book, auction: self.auction(id) }
            .to_account_metas(None);
        self.send(ix::CompleteReopen {}.data(), metas, &[&k])
    }

    // ── backstop inventory ──

    fn inventory(&self) -> Pubkey {
        pda(&[INVENTORY_SEED, self.pool().as_ref(), self.stock_mint.as_ref()])
    }

    fn get_inventory(&self) -> Inventory {
        let a = self.svm.get_account(&self.inventory()).unwrap();
        Inventory::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn resell(&mut self) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::ResellInventory {
            pool: self.pool(), inventory: self.inventory(), market: self.market, clock: self.clock, calendar: self.calendar,
            risk_config: pda(&[RISK_CONFIG_SEED]),
        }
        .to_account_metas(None);
        self.send(ix::ResellInventory {}.data(), metas, &[&k])
    }

    fn gda_buy(&mut self, buyer: &Keypair, qty: u64, max_cost: u64) -> Result<(), String> {
        let metas = acc::GdaBuy {
            buyer: buyer.pubkey(), config: self.config, pool: self.pool(), inventory: self.inventory(), market: self.market,
            clock: self.clock, calendar: self.calendar, risk_config: pda(&[RISK_CONFIG_SEED]), collateral_mint: self.stock_mint,
            pool_tokens: get_associated_token_address(&self.pool(), &self.stock_mint),
            buyer_tokens: get_associated_token_address(&buyer.pubkey(), &self.stock_mint),
            buyer_usdc: get_associated_token_address(&buyer.pubkey(), &self.usdc_mint), usdc_vault: self.usdc_vault,
            token_program: TOKEN_ID, associated_token_program: ATA_PROGRAM_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::GdaBuy { qty, max_cost }.data(), metas, &[buyer])
    }

    fn close_gda(&mut self, signer: &Keypair) -> Result<(), String> {
        let metas = acc::CloseGda {
            signer: signer.pubkey(), config: self.config, pool: self.pool(), inventory: self.inventory(), market: self.market,
            risk_config: pda(&[RISK_CONFIG_SEED]),
        }
        .to_account_metas(None);
        self.send(ix::CloseGda {}.data(), metas, &[signer])
    }

    fn mark_inventory(&mut self) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::MarkInventory { pool: self.pool(), inventory: self.inventory(), market: self.market, risk_config: pda(&[RISK_CONFIG_SEED]) }
            .to_account_metas(None);
        self.send(ix::MarkInventory {}.data(), metas, &[&k])
    }

    fn redemption(&self, id: u64) -> Pubkey {
        pda(&[REDEMPTION_SEED, self.pool().as_ref(), &id.to_le_bytes()])
    }

    fn get_redemption(&self, id: u64) -> Redemption {
        let a = self.svm.get_account(&self.redemption(id)).unwrap();
        Redemption::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn request_redemption(&mut self) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let id = self.get_pool().redemptions + 1;
        let metas = acc::RequestRedemption {
            cranker: k.pubkey(), pool: self.pool(), inventory: self.inventory(), market: self.market, collateral_mint: self.stock_mint,
            pool_tokens: get_associated_token_address(&self.pool(), &self.stock_mint), redemption: self.redemption(id),
            token_program: TOKEN_ID, system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::RequestRedemption {}.data(), metas, &[&k])
    }

    fn claim_redemption(&mut self, id: u64) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let metas = acc::ClaimRedemption {
            config: self.config, usdc_mint: self.usdc_mint, usdc_vault: self.usdc_vault, pool: self.pool(), market: self.market,
            redemption: self.redemption(id), token_program: TOKEN_ID,
        }
        .to_account_metas(None);
        self.send(ix::ClaimRedemption {}.data(), metas, &[&k])
    }

    /// A bidder with `usdc` test USDC.
    fn bidder(&mut self, usdc: u64) -> Keypair {
        let b = self.user();
        self.faucet_usdc(&b, usdc);
        b
    }

    // ── senior vault ──

    fn with_markets(&self, mut metas: Vec<AccountMeta>) -> Vec<AccountMeta> {
        metas.push(AccountMeta::new(self.market, false));
        metas
    }

    fn lend_deposit(&mut self, user: &Keypair, assets: u64) -> Result<(), String> {
        let metas = self.with_markets(
            acc::LendDeposit {
                owner: user.pubkey(),
                config: self.config,
                senior: self.senior,
                usdc_mint: self.usdc_mint,
                share_mint: self.share_mint,
                owner_usdc: get_associated_token_address(&user.pubkey(), &self.usdc_mint),
                owner_shares: get_associated_token_address(&user.pubkey(), &self.share_mint),
                dead_shares: pda(&[DEAD_SHARES_SEED]),
                usdc_vault: self.usdc_vault,
                token_program: TOKEN_ID,
                associated_token_program: ATA_PROGRAM_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix::LendDeposit { assets }.data(), metas, &[user])
    }

    fn lend_redeem(&mut self, user: &Keypair, shares: u64) -> Result<(), String> {
        let metas = self.with_markets(
            acc::LendRedeem {
                owner: user.pubkey(),
                config: self.config,
                senior: self.senior,
                usdc_mint: self.usdc_mint,
                share_mint: self.share_mint,
                owner_shares: get_associated_token_address(&user.pubkey(), &self.share_mint),
                owner_usdc: get_associated_token_address(&user.pubkey(), &self.usdc_mint),
                usdc_vault: self.usdc_vault,
                token_program: TOKEN_ID,
                associated_token_program: ATA_PROGRAM_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix::LendRedeem { shares }.data(), metas, &[user])
    }

    fn request(&self, id: u64) -> Pubkey {
        pda(&[REDEEM_SEED, &id.to_le_bytes()])
    }

    fn request_redeem(&mut self, user: &Keypair, shares: u64, id: u64) -> Result<(), String> {
        let metas = acc::RequestRedeem {
            owner: user.pubkey(),
            senior: self.senior,
            share_mint: self.share_mint,
            owner_shares: get_associated_token_address(&user.pubkey(), &self.share_mint),
            share_escrow: pda(&[SHARE_ESCROW_SEED]),
            request: self.request(id),
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::RequestRedeem { shares }.data(), metas, &[user])
    }

    fn process_queue(&mut self, ids: &[u64]) -> Result<(), String> {
        let k = self.keeper.insecure_clone();
        let mut metas = self.with_markets(
            acc::ProcessRedeemQueue {
                cranker: k.pubkey(),
                senior: self.senior,
                share_mint: self.share_mint,
                share_escrow: pda(&[SHARE_ESCROW_SEED]),
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
        );
        metas.extend(ids.iter().map(|&i| AccountMeta::new(self.request(i), false)));
        self.send(ix::ProcessRedeemQueue {}.data(), metas, &[&k])
    }

    fn claim(&mut self, user: &Keypair, id: u64) -> Result<(), String> {
        let metas = acc::ClaimRedeem {
            owner: user.pubkey(),
            config: self.config,
            senior: self.senior,
            usdc_mint: self.usdc_mint,
            request: self.request(id),
            owner_usdc: get_associated_token_address(&user.pubkey(), &self.usdc_mint),
            usdc_vault: self.usdc_vault,
            token_program: TOKEN_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        self.send(ix::ClaimRedeem {}.data(), metas, &[user])
    }

    // ── reads ──

    fn get_position(&self, owner: &Pubkey) -> Position {
        let a = self.svm.get_account(&self.position(owner)).unwrap();
        Position::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn get_market(&self) -> Market {
        let a = self.svm.get_account(&self.market).unwrap();
        Market::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn get_senior(&self) -> SeniorVault {
        let a = self.svm.get_account(&self.senior).unwrap();
        SeniorVault::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn debt(&self, owner: &Pubkey) -> u64 {
        self.get_market().debt_of(self.get_position(owner).borrow_shares).unwrap()
    }

    fn balance(&self, owner: &Pubkey, mint: &Pubkey) -> u64 {
        get_spl_account::<spl_token::state::Account>(&self.svm, &get_associated_token_address(owner, mint))
            .map(|a| a.amount)
            .unwrap_or(0)
    }

    /// A user holding 100 stock tokens (worth 20,000 USDC at 200) deposited as collateral.
    fn funded_user(&mut self) -> Keypair {
        let u = self.user();
        let mint = self.stock_mint;
        self.faucet(&u, mint, 100 * ONE).unwrap();
        self.deposit(&u, 100 * ONE).unwrap();
        u
    }
}

const INSTRUCTIONS_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
const ED25519_PROGRAM: Pubkey = anchor_lang::pubkey!("Ed25519SigVerify111111111111111111111111111");

fn report_msg(market: Pubkey, price: u64, at: i64) -> Vec<u8> {
    [&REPORT_DOMAIN[..], market.as_ref(), &price.to_le_bytes(), &at.to_le_bytes()].concat()
}

/// One Ed25519 precompile instruction verifying every report's signature, all offsets inside itself.
fn ed25519_ix(reports: &[(&Keypair, Pubkey, u64, i64)]) -> Instruction {
    let n = reports.len();
    let header = 2 + 14 * n;
    let block = 32 + 64 + REPORT_LEN;
    let mut data = vec![n as u8, 0];
    let mut payload = Vec::new();
    for (i, (k, market, price, at)) in reports.iter().enumerate() {
        let base = header + i * block;
        let msg = report_msg(*market, *price, *at);
        let sig = k.sign_message(&msg);
        for v in [(base + 32) as u16, u16::MAX, base as u16, u16::MAX, (base + 96) as u16, REPORT_LEN as u16, u16::MAX] {
            data.extend_from_slice(&v.to_le_bytes());
        }
        payload.extend_from_slice(k.pubkey().as_ref());
        payload.extend_from_slice(sig.as_ref());
        payload.extend_from_slice(&msg);
    }
    data.extend(payload);
    Instruction { program_id: ED25519_PROGRAM, accounts: vec![], data }
}

fn set_time(svm: &mut LiteSVM, ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = ts;
    svm.set_sysvar(&clock);
}

fn assert_err(res: Result<(), String>, needle: &str) {
    let e = res.expect_err("expected failure");
    assert!(e.contains(needle), "expected `{needle}` in:\n{e}");
}

// ───────────── borrowing ─────────────

#[test]
fn borrow_respects_open_ltv() {
    let mut env = Env::new();
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap(); // exactly 60%
    assert_err(env.borrow(&u, 1), "BorrowLimitExceeded");
    assert_eq!(env.debt(&u.pubkey()), 12_000 * ONE);
    assert_eq!(env.balance(&u.pubkey(), &env.usdc_mint.clone()), 12_000 * ONE);
}

#[test]
fn closed_market_uses_closure_safe_ltv() {
    let mut env = Env::new();
    let u = env.funded_user();
    env.at(T0 + 5 * H + 60); // after the close: overnight closure, safe LTV 40% on debt projected 1 day ahead
    assert_err(env.borrow(&u, 8_000 * ONE), "BorrowLimitExceeded");
    env.borrow(&u, 7_990 * ONE).unwrap();
    assert_err(env.borrow(&u, 10 * ONE), "BorrowLimitExceeded");
}

#[test]
fn bell_window_applies_the_safe_rule_before_the_close() {
    let mut env = Env::new();
    let u = env.funded_user();
    env.at(T0 + 3 * H + 60); // regular session, but inside the Bell window (close − 2h)
    assert_eq!(env.get_clock().state, ClockState::Regular);
    assert_err(env.borrow(&u, 8_000 * ONE), "BorrowLimitExceeded");
    env.borrow(&u, 7_990 * ONE).unwrap();
}

#[test]
fn clock_runs_close_reopen_regular() {
    let mut env = Env::new();
    assert_eq!(env.get_clock().state, ClockState::Regular);
    env.at(T0 + 5 * H + 60);
    let c = env.get_clock();
    assert_eq!((c.state, c.closure_id, c.closure_type), (ClockState::Closed, 1, CLOSURE_OVERNIGHT));
    assert_eq!(c.ref_price, 200 * ONE);
    assert_eq!(c.reopen_at, T0 - H + 24 * H);

    // Next day's open: the first fresh price is the open print and REOPEN holds for the window.
    env.at(T0 + 23 * H + 60);
    let c = env.get_clock();
    assert_eq!(c.state, ClockState::Reopen);
    assert_eq!(c.open_print, 200 * ONE);
    let u = env.funded_user();
    assert_err(env.borrow(&u, ONE), "BorrowPaused");

    assert_err(env.complete_reopen(), "ReopenNotDone"); // the queue window runs first
    env.at(T0 + 23 * H + 60 + TIMINGS_REOPEN[0]);
    assert_eq!(env.get_clock().state, ClockState::Reopen); // no timer: it ends when the reopen is done
    env.complete_reopen().unwrap(); // no auction this closure
    let c = env.get_clock();
    assert_eq!(c.state, ClockState::Regular);
    assert!(!c.reopen_pending);
    env.borrow(&u, 12_000 * ONE).unwrap(); // max LTV again
}


#[test]
fn guardian_halt_opens_a_closure() {
    let mut env = Env::new();
    let u = env.funded_user();
    assert_err(env.restrict(ClockState::Halted, T0 + 8 * 24 * H), "InvalidRestriction");
    env.restrict(ClockState::Halted, T0 + H).unwrap();
    let c = env.get_clock();
    assert_eq!((c.state, c.closure_type), (ClockState::Halted, CLOSURE_HALT));
    assert_err(env.restrict(ClockState::Halted, T0 + 30 * 60), "InvalidRestriction"); // never shortens
    // Halts use the holiday-weekend set (40%) on debt projected to the next open.
    assert_err(env.borrow(&u, 8_000 * ONE), "BorrowLimitExceeded");
    env.borrow(&u, 7_990 * ONE).unwrap();
}

#[test]
fn sigma_falls_at_most_ten_percent_a_day() {
    let mut env = Env::new();
    let s0 = env.get_risk_set(CLOSURE_OVERNIGHT).sigma;
    assert_err(env.update_sigma(CLOSURE_OVERNIGHT, s0 * 8 / 10), "SigmaDecreaseTooFast");
    env.update_sigma(CLOSURE_OVERNIGHT, s0 * 2).unwrap(); // up: any amount
    set_time(&mut env.svm, T0 + 24 * H);
    assert_err(env.update_sigma(CLOSURE_OVERNIGHT, s0 * 2 / 100 * 89), "SigmaDecreaseTooFast");
    env.update_sigma(CLOSURE_OVERNIGHT, s0 * 2 / 100 * 90).unwrap();
    assert_err(env.update_sigma(CLOSURE_OVERNIGHT, WAD / 20), "SigmaDecreaseTooFast"); // under the floor
}

#[test]
fn withdraw_keeps_position_within_limit() {
    let mut env = Env::new();
    let u = env.funded_user();
    env.borrow(&u, 6_000 * ONE).unwrap(); // needs 50 tokens at 60%
    assert_err(env.withdraw(&u, 50 * ONE + 1), "BorrowLimitExceeded");
    env.withdraw(&u, 50 * ONE).unwrap();
    assert_err(env.withdraw(&u, 51 * ONE), "InsufficientCollateral");
}

#[test]
fn stale_price_blocks_borrow() {
    let mut env = Env::new();
    let u = env.funded_user();
    set_time(&mut env.svm, T0 + MAX_PRICE_AGE_SECS + 1);
    assert_err(env.borrow(&u, ONE), "StalePrice");
    env.set_price(200 * ONE).unwrap();
    env.borrow(&u, ONE).unwrap();
}

#[test]
fn only_keeper_or_admin_can_update() {
    let mut env = Env::new();
    let stranger = env.user();
    assert_err(env.keeper_update(ix::SetPrice { price: ONE }.data(), &stranger), "NotKeeper");
    let admin = env.admin.insecure_clone();
    env.keeper_update(ix::SetPrice { price: 300 * ONE }.data(), &admin).unwrap();
}

#[test]
fn faucet_is_capped() {
    let mut env = Env::new();
    let u = env.user();
    let mint = env.stock_mint;
    assert_err(env.faucet(&u, mint, FAUCET_MAX_WHOLE * ONE + 1), "FaucetCapExceeded");
    env.faucet(&u, mint, FAUCET_MAX_WHOLE * ONE).unwrap();
}

#[test]
fn borrowing_is_limited_by_market_liquidity() {
    let mut env = Env::with_liquidity(5_000 * ONE);
    let u = env.funded_user();
    assert_err(env.borrow(&u, 5_000 * ONE + 1), "InsufficientLiquidity");
    env.borrow(&u, 5_000 * ONE).unwrap();
}


#[test]
fn repay_then_withdraw_everything() {
    let mut env = Env::new();
    let u = env.funded_user();
    env.borrow(&u, 5_000 * ONE).unwrap();
    assert_err(env.withdraw(&u, 100 * ONE), "BorrowLimitExceeded");
    env.repay(&u, 10_000 * ONE).unwrap(); // over-repay only takes the debt
    assert_eq!(env.get_position(&u.pubkey()).borrow_shares, 0);
    assert_eq!(env.balance(&u.pubkey(), &env.usdc_mint.clone()), 0);
    assert_err(env.repay(&u, ONE), "NoDebt");
    env.withdraw(&u, 100 * ONE).unwrap();
    assert_eq!(env.balance(&u.pubkey(), &env.stock_mint.clone()), 100 * ONE);
}

// ───────────── interest ─────────────

#[test]
fn interest_accrues_and_splits_fees() {
    let mut env = Env::new();
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    set_time(&mut env.svm, T0 + YEAR);

    // U = 12,000 / 1,000,000 = 1.2% → r = 2% + 6% × 1.2/90 = 2.08% → ~249.6 USDC of interest in a year.
    env.faucet_usdc(&u, 1_000 * ONE);
    let before = env.get_senior().total_supplied;
    env.repay(&u, 20_000 * ONE).unwrap();
    let m = env.get_market();
    let interest = m.pool_fee_accrued + m.treasury_fee_accrued + (env.get_senior().total_supplied - before);
    assert!((249_000_000..250_500_000).contains(&interest), "interest {interest}");
    assert_eq!(m.pool_fee_accrued, interest / 10);
    assert_eq!(m.treasury_fee_accrued, interest / 5 - interest / 10);
    assert_eq!(m.total_borrow_assets, 0);
    assert_eq!(env.get_position(&u.pubkey()).borrow_shares, 0);
    // Borrowed 12,000 + 1,000 from the faucet, repaid principal + interest.
    assert_eq!(env.balance(&u.pubkey(), &env.usdc_mint.clone()), 1_000 * ONE - interest);
}

// ───────────── senior vault ─────────────

#[test]
fn lender_earns_the_senior_share_of_interest() {
    let mut env = Env::new();
    let lender = env.user();
    env.faucet_usdc(&lender, 1_000 * ONE);
    env.lend_deposit(&lender, 1_000 * ONE).unwrap();
    let shares = env.balance(&lender.pubkey(), &env.share_mint.clone());
    assert!(shares > 0);

    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    set_time(&mut env.svm, T0 + YEAR);
    env.faucet_usdc(&u, 1_000 * ONE);
    env.repay(&u, 20_000 * ONE).unwrap();

    env.lend_redeem(&lender, shares).unwrap();
    let got = env.balance(&lender.pubkey(), &env.usdc_mint.clone());
    // 80% of ~249.6 USDC spread over ~1.001M USDC of deposits: ~0.199 USDC on 1,000.
    assert!(got > 1_000 * ONE + 150_000 && got < 1_000 * ONE + 250_000, "got {got}");
}

#[test]
fn deposits_are_supplied_to_the_market() {
    let env = Env::new();
    let m = env.get_market();
    let s = env.get_senior();
    assert_eq!(m.total_supply_assets, 1_000_000 * ONE);
    assert_eq!(s.total_supplied, 1_000_000 * ONE);
    assert_eq!(s.idle, 0);
}

#[test]
fn redeem_queue_pays_when_liquidity_returns() {
    let mut env = Env::with_liquidity(20_000 * ONE);
    let admin = env.admin.insecure_clone();
    let shares = env.balance(&admin.pubkey(), &env.share_mint.clone());
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap(); // 8,000 left in the market

    assert_err(env.lend_redeem(&admin, shares), "VaultIlliquid");
    env.request_redeem(&admin, shares, 1).unwrap();
    env.process_queue(&[1]).unwrap(); // not enough: stays queued
    assert_eq!(env.get_senior().queue_head, 1);
    assert_err(env.claim(&admin, 1), "RequestNotProcessed");

    env.repay(&u, 12_000 * ONE).unwrap();
    env.process_queue(&[1]).unwrap();
    let s = env.get_senior();
    assert_eq!(s.queue_head, 2);
    assert_eq!(s.pending_redeem_shares, 0);
    env.claim(&admin, 1).unwrap();
    let got = env.balance(&admin.pubkey(), &env.usdc_mint.clone());
    assert!(got >= 20_000 * ONE - 1 && got <= 20_000 * ONE, "got {got}"); // the dead shares keep a dust
    assert_eq!(env.get_senior().claimable_assets, 0);
}

#[test]
fn closure_price_can_lower_value_never_raise_it() {
    let mut env = Env::new();
    let u = env.funded_user();
    env.at(T0 + 5 * H + 60); // closed at 200 (the reference)
    env.set_price(400 * ONE).unwrap(); // a weekend print twice as high
    assert_err(env.borrow(&u, 8_000 * ONE), "BorrowLimitExceeded"); // still valued at 200
    env.borrow(&u, 7_990 * ONE).unwrap();
    env.set_price(100 * ONE).unwrap(); // and a lower one does count
    assert_err(env.withdraw(&u, ONE), "BorrowLimitExceeded");
}

#[test]
fn clock_started_inside_a_weekend_opens_that_weekend() {
    // Day 2's close is a weekend; start between its extended close and day 3's open.
    let start = T0 - H + 2 * 24 * H + 8 * H;
    let env = Env::build(0, start);
    let c = env.get_clock();
    assert_eq!((c.state, c.closure_type, c.closure_id), (ClockState::Closed, CLOSURE_WEEKEND, 1));
    assert_eq!(c.close_at, T0 - H + 2 * 24 * H + 6 * H);
    assert_eq!(c.reopen_at, T0 - H + 3 * 24 * H);
}

#[test]
fn clock_started_in_a_later_regular_session_is_simply_open() {
    let env = Env::build(0, T0 + 24 * H); // day 1, regular hours
    let c = env.get_clock();
    assert_eq!((c.state, c.closure_id, c.reopen_pending), (ClockState::Regular, 0, false));
}

// ───────────── underwriter pool, Gap Cover, waterfall ─────────────

/// The admin funds the pool with `amount` USDC between epochs.
fn fund_pool(env: &mut Env, amount: u64) -> Keypair {
    let u = env.user();
    env.faucet_usdc(&u, amount);
    env.pool_deposit(&u, amount).unwrap();
    u
}

#[test]
fn pool_deposit_mints_at_nav_between_epochs() {
    let mut env = Env::new();
    let u = fund_pool(&mut env, 5_000 * ONE);
    assert_eq!(env.get_pool().nav(), 5_000 * ONE);
    assert_eq!(env.balance(&u.pubkey(), &env.pool_shares()), 5_000 * ONE * 1_000);
    env.open_epoch().unwrap();
    assert_err(env.pool_deposit(&u, ONE), "EpochNotReady");
}

#[test]
fn cover_keeps_max_ltv_through_the_bell_window() {
    let mut env = Env::new();
    fund_pool(&mut env, 50_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 10_000 * ONE).unwrap(); // 50%
    env.open_epoch().unwrap();
    env.faucet_usdc(&u, 5_000 * ONE);
    // The test sets are harsh (a 25% chance of a 60% gap), so the premium is large.
    assert_err(env.write_cover(&u, ONE, false, false), "PremiumAboveMax");
    let cash0 = env.balance(&u.pubkey(), &env.usdc_mint.clone());
    env.write_cover(&u, 5_000 * ONE, false, false).unwrap(); // paid in cash
    let p = env.get_policy(&u.pubkey(), 1);
    assert!(p.premium >= 500_000 && !p.auto, "premium {}", p.premium);
    assert_eq!(env.balance(&u.pubkey(), &env.usdc_mint.clone()), cash0 - p.premium);
    assert_eq!(env.get_pool().unearned_premiums, p.premium);
    // One policy per loan per closure: creating the policy account a second time is refused.
    assert_err(env.write_cover(&u, 5_000 * ONE, false, false), "Program 11111111111111111111111111111111 failed");

    env.at(T0 + 3 * H + 60); // Bell window: uncovered loans fall to the safe rule
    let v = env.user();
    let mint = env.stock_mint;
    env.faucet(&v, mint, 100 * ONE).unwrap();
    env.deposit(&v, 100 * ONE).unwrap();
    assert_err(env.borrow(&v, 10_000 * ONE), "BorrowLimitExceeded");
    let policy = env.policy(&u.pubkey(), 1);
    env.borrow_with(&u, 1_990 * ONE, Some(policy)).unwrap(); // covered: max LTV (60%) still applies, interest included
    assert_err(env.borrow_with(&u, 20 * ONE, Some(policy)), "BorrowLimitExceeded");
}

#[test]
fn bell_auto_covers_a_loan_that_needs_action() {
    let mut env = Env::new();
    fund_pool(&mut env, 50_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap(); // 60% > 40% safe
    env.open_epoch().unwrap();
    assert_err(env.write_cover(&u, 0, true, true), "CoverWindowClosed"); // the Bell runs after its deadline
    env.at(T0 + 5 * H - 10 * 60); // after the deadline (close − 15 min), before the close
    let debt0 = env.debt(&u.pubkey());
    env.write_cover(&u, 0, true, true).unwrap();
    let p = env.get_policy(&u.pubkey(), 1);
    assert!(p.auto);
    assert!(env.debt(&u.pubkey()) >= debt0 + p.premium);

    // A loan at 5% LTV is fine at the 40% safe LTV: the Bell leaves it alone.
    let safe = env.funded_user();
    env.borrow(&safe, 1_000 * ONE).unwrap();
    assert_err(env.write_cover(&safe, 0, true, true), "BellNotNeeded");
}

#[test]
fn cover_needs_pool_capacity() {
    let mut env = Env::new();
    fund_pool(&mut env, 1_000 * ONE); // u = worst loss / J must stay ≤ 50%
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    env.open_epoch().unwrap();
    assert_err(env.write_cover(&u, u64::MAX, true, false), "PoolCapacityExceeded");
}

#[test]
fn epoch_settles_premiums_deposits_and_withdrawals() {
    let mut env = Env::new();
    let lp = fund_pool(&mut env, 50_000 * ONE);
    let shares = env.balance(&lp.pubkey(), &env.pool_shares());
    env.pool_request_withdraw(&lp, shares / 2).unwrap(); // joins the next epoch
    let u = env.funded_user();
    env.borrow(&u, 10_000 * ONE).unwrap();
    let seq = env.open_epoch().unwrap();
    assert_eq!(env.get_epoch(seq).withdraw_shares_queued, shares / 2);
    env.write_cover(&u, 5_000 * ONE, true, false).unwrap(); // added to debt
    let premium = env.get_policy(&u.pubkey(), 1).premium;
    let late = env.user();
    env.faucet_usdc(&late, 1_000 * ONE);
    env.pool_deposit_queued(&late, 1_000 * ONE).unwrap();
    assert_eq!(env.get_pool().nav(), 50_000 * ONE); // queued cash and unearned premium are not NAV yet

    env.at(T0 + 5 * H - 10 * 60);
    env.snapshot_epoch().unwrap();
    assert_eq!(env.get_epoch(seq).equity_at_risk, 50_000 * ONE);
    assert_err(env.settle_epoch(), "EpochNotSettleable");
    // Next open, its REOPEN window, then the settle delay.
    env.at(T0 + 23 * H + 60);
    env.at(T0 + 23 * H + 60 + TIMINGS_REOPEN[0]);
    env.complete_reopen().unwrap();
    set_time(&mut env.svm, T0 + 23 * H + 60 + REOPEN_WINDOW_SECS + SETTLE_DELAY_SECS);
    env.settle_epoch().unwrap();
    let e = env.get_epoch(seq);
    assert_eq!(e.phase, EPOCH_SETTLED);
    assert_eq!(e.nav_after, 50_000 * ONE + premium);
    // The withdrawing half gets half of NAV after (premium included); the late deposit is minted at that price.
    env.pool_claim(&lp, seq).unwrap();
    let got = env.balance(&lp.pubkey(), &env.usdc_mint.clone());
    let half = (50_000 * ONE + premium) / 2;
    assert!(got <= half && got + 2 >= half, "withdrew {got}, half of NAV {half}");
    assert_err(env.pool_claim(&lp, seq), "AccountNotInitialized"); // the ticket is closed
    env.pool_claim(&late, seq).unwrap();
    let minted = env.balance(&late.pubkey(), &env.pool_shares());
    // 1,000 USDC at the settlement price (NAV after / supply): fewer shares than at the first deposit's price.
    assert!(minted > 0 && minted < 1_000 * ONE * 1_000, "minted {minted}");
    assert!(!env.get_pool().epoch_active);
    assert_eq!(env.get_pool().nav(), 50_000 * ONE + premium - got + 1_000 * ONE);
}


#[test]
fn sweep_moves_interest_shares_to_pool_and_reserve() {
    let mut env = Env::new();
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    set_time(&mut env.svm, T0 + YEAR);
    env.faucet_usdc(&u, 1_000 * ONE);
    env.repay(&u, 20_000 * ONE).unwrap();
    let m = env.get_market();
    let (fp, ft) = (m.pool_fee_accrued, m.treasury_fee_accrued);
    assert!(fp > 0 && ft > 0);
    env.sweep_fees().unwrap();
    assert_eq!(env.get_pool().cash, fp);
    let m = env.get_market();
    assert_eq!((m.pool_fee_accrued, m.treasury_fee_accrued), (0, 0));
}

// ───────────── auctions ─────────────

#[test]
fn intraday_auction_sells_at_one_price() {
    let mut env = Env::new();
    fund_pool(&mut env, 50_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    assert_err(env.flag(KIND_INTRADAY, &u.pubkey(), 1), "NotLiquidatable");
    env.set_price(150 * ONE).unwrap(); // 12,000 > 15,000 × 75%
    env.flag(KIND_INTRADAY, &u.pubkey(), 1).unwrap();
    let a = env.get_auction(1);
    assert_eq!(a.reserve, 150 * ONE); // (1 − κ) × V, κ = 0 in the test config
    assert_err(env.fix(&u.pubkey(), 1), "WrongAuctionPhase"); // lot fixes at +15 s

    set_time(&mut env.svm, T0 + 15);
    env.fix(&u.pubkey(), 1).unwrap();
    let lot = env.get_auction(1).lot;
    assert!(lot > 0 && lot < 100 * ONE, "partial lot {lot}");
    // Two bidders; the higher one fills first and both pay the same p*.
    let (b1, b2) = (env.bidder(20_000 * ONE), env.bidder(20_000 * ONE));
    assert_err(env.place_bid(&b1, 1, ONE, 149 * ONE), "BidBelowReserve");
    env.place_bid(&b1, 1, lot / 2, 155 * ONE).unwrap();
    env.place_bid(&b2, 1, lot, 152 * ONE).unwrap();
    assert_err(env.clear(1, &[b1.pubkey(), b2.pubkey()]), "WrongAuctionPhase");
    set_time(&mut env.svm, T0 + 60);
    assert_err(env.clear(1, &[b1.pubkey()]), "WrongBidAccounts"); // every bid, once
    env.clear(1, &[b1.pubkey(), b2.pubkey()]).unwrap();
    let a = env.get_auction(1);
    assert_eq!((a.p_star, a.q_pool, a.filled), (152 * ONE, 0, lot)); // p* = the last price needed
    assert_eq!(env.get_bid(1, &b1.pubkey()).fill, lot / 2);
    assert_eq!(env.get_bid(1, &b2.pubkey()).fill, lot - lot / 2);

    let debt0 = env.debt(&u.pubkey());
    env.settle_lot(&u.pubkey(), 1).unwrap();
    let debt1 = env.debt(&u.pubkey());
    let p = env.get_position(&u.pubkey());
    let hf = (p.collateral as f64 / 1e6 * 150.0 * 0.75) / (debt1 as f64 / 1e6);
    assert!(debt1 < debt0 && hf > 1.0, "debt {debt0} → {debt1}, HF {hf:.3}");
    assert!(env.get_pool().cash > 50_000 * ONE); // ⅓ of the penalty

    let before = env.balance(&b1.pubkey(), &env.usdc_mint.clone());
    env.claim_bid(&b1, 1).unwrap();
    assert_eq!(env.balance(&b1.pubkey(), &env.stock_mint.clone()), lot / 2);
    assert_eq!(env.balance(&b1.pubkey(), &env.usdc_mint.clone()) - before, (lot / 2) * 3); // paid p* 152, escrowed 155
}

#[test]
fn pool_backstops_an_unbid_lot_at_the_reserve() {
    let mut env = Env::new();
    fund_pool(&mut env, 50_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    env.set_price(150 * ONE).unwrap();
    env.flag(KIND_INTRADAY, &u.pubkey(), 1).unwrap();
    set_time(&mut env.svm, T0 + 15);
    env.fix(&u.pubkey(), 1).unwrap();
    set_time(&mut env.svm, T0 + 60);
    env.clear(1, &[]).unwrap();
    let a = env.get_auction(1);
    assert_eq!((a.q_pool, a.filled), (a.lot, 0));
    assert_eq!(env.balance(&env.pool(), &env.stock_mint.clone()), a.lot); // the pool's inventory
    env.settle_lot(&u.pubkey(), 1).unwrap();
    assert!(env.debt(&u.pubkey()) < 12_000 * ONE);
}

#[test]
fn reopen_sealed_bids_then_the_reopen_completes() {
    let mut env = Env::new();
    fund_pool(&mut env, 50_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    env.at(T0 + 5 * H + 60); // closed
    set_time(&mut env.svm, T0 + 23 * H + 60);
    env.set_price(140 * ONE).unwrap(); // opens 30% lower: the open print
    env.poke().unwrap();
    assert_eq!(env.get_clock().state, ClockState::Reopen);
    env.flag(KIND_REOPEN, &u.pubkey(), 1).unwrap();
    let a = env.get_auction(1);
    assert_eq!(a.reserve, 140 * ONE); // (1 − κ) × open print, κ = 0 in the test config

    let t0 = env.get_clock().open_print_at;
    set_time(&mut env.svm, t0 + TIMINGS_REOPEN[0]);
    env.fix(&u.pubkey(), 1).unwrap();
    let lot = env.get_auction(1).lot;
    let (good, low) = (env.bidder(20_000 * ONE), env.bidder(5_000 * ONE));
    env.commit_bid(&good, 1, lot, 141 * ONE, [1; 32], 15_000 * ONE).unwrap();
    env.commit_bid(&low, 1, lot, 100 * ONE, [2; 32], 5_000 * ONE).unwrap(); // below R: can't be revealed
    assert_eq!(env.get_bid(1, &good.pubkey()).bond, 1_500 * ONE);
    assert_err(env.reveal_bid(&good, 1, lot, 141 * ONE, [1; 32]), "WrongAuctionPhase"); // reveal window not open
    set_time(&mut env.svm, t0 + TIMINGS_REOPEN[2]);
    assert_err(env.reveal_bid(&good, 1, lot, 140 * ONE, [1; 32]), "CommitmentMismatch");
    env.reveal_bid(&good, 1, lot, 141 * ONE, [1; 32]).unwrap();
    assert_err(env.reveal_bid(&low, 1, lot, 100 * ONE, [2; 32]), "BidBelowReserve");
    assert_err(env.complete_reopen(), "ReopenNotDone");
    set_time(&mut env.svm, t0 + TIMINGS_REOPEN[3]);
    let pool0 = env.get_pool().cash;
    env.clear(1, &[good.pubkey(), low.pubkey()]).unwrap();
    let a = env.get_auction(1);
    assert_eq!((a.p_star, a.filled, a.bonds_forfeited), (141 * ONE, lot, 500 * ONE));
    assert_eq!(env.get_pool().cash, pool0 + 500 * ONE); // the unrevealed bond
    env.settle_lot(&u.pubkey(), 1).unwrap();
    env.complete_reopen().unwrap();
    assert_eq!(env.get_clock().state, ClockState::Regular);
    env.claim_bid(&low, 1).unwrap();
    assert_eq!(env.balance(&low.pubkey(), &env.usdc_mint.clone()), 4_500 * ONE); // bond forfeited
}

#[test]
fn bad_debt_through_an_auction_hits_the_pool_first() {
    let mut env = Env::new();
    fund_pool(&mut env, 10_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    env.set_price(60 * ONE).unwrap(); // collateral 6,000 vs debt 12,000
    env.flag(KIND_INTRADAY, &u.pubkey(), 1).unwrap();
    set_time(&mut env.svm, T0 + 15);
    env.fix(&u.pubkey(), 1).unwrap();
    assert_eq!(env.get_auction(1).lot, 100 * ONE); // full close
    let b = env.bidder(10_000 * ONE);
    env.place_bid(&b, 1, 100 * ONE, 60 * ONE).unwrap();
    set_time(&mut env.svm, T0 + 60);
    env.clear(1, &[b.pubkey()]).unwrap();
    let senior0 = env.get_senior().total_supplied;
    env.settle_lot(&u.pubkey(), 1).unwrap();
    let p = env.get_position(&u.pubkey());
    assert_eq!((p.collateral, p.borrow_shares), (0, 0));
    let pool = env.get_pool();
    assert!(pool.losses_paid > 5_900 * ONE && pool.losses_paid < 6_100 * ONE, "pool paid {}", pool.losses_paid);
    assert!(env.get_senior().total_supplied >= senior0); // the pool covered all of it: seniors lost nothing (interest still accrues)
}

#[test]
fn preclose_sale_for_a_loan_too_risky_to_cover() {
    let mut env = Env::new();
    fund_pool(&mut env, 50_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    env.open_epoch().unwrap();
    env.set_price(195 * ONE).unwrap(); // LTV 61.5%: above the 60.5% coverable limit, under liquidation
    env.at(T0 + 5 * H - 14 * 60); // after the Bell deadline
    assert_err(env.write_cover(&u, 0, true, true), "LtvAboveCoverable");
    env.flag(KIND_PRECLOSE, &u.pubkey(), 1).unwrap();
    let a = env.get_auction(1);
    assert_eq!(a.deadlines[0], T0 + 5 * H - 300); // lot fixes 5 min before the close
    set_time(&mut env.svm, T0 + 5 * H - 300);
    env.fix(&u.pubkey(), 1).unwrap();
    let lot = env.get_auction(1).lot;
    assert!(lot > 0 && lot < 100 * ONE, "lot {lot}");
    set_time(&mut env.svm, T0 + 5 * H - 30);
    env.clear(1, &[]).unwrap(); // the pool takes it at R_pre
    env.settle_lot(&u.pubkey(), 1).unwrap();
    let p = env.get_position(&u.pubkey());
    let ltv = env.debt(&u.pubkey()) as f64 / (p.collateral as f64 * 195.0);
    assert!(ltv <= 0.41, "after the pre-close sale, LTV {ltv:.3} is at the 40% safe LTV");
}

// ───────────── signed prices and the guardian ─────────────

#[test]
fn prices_come_signed_by_k_of_n_relayers() {
    let mut env = Env::new();
    let nodes: Vec<Keypair> = (0..3).map(|_| Keypair::new()).collect();
    let outsider = Keypair::new();
    env.set_oracle(nodes.iter().map(|k| k.pubkey()).collect(), 2, false).unwrap();
    assert_err(env.set_price(210 * ONE), "KeeperPriceDisabled"); // the keeper can't push any more

    let (m, t) = (env.market, T0 + 10);
    set_time(&mut env.svm, t);
    assert_err(env.submit_prices(&[(&nodes[0], m, 210 * ONE, t)]), "NotEnoughSignatures");
    assert_err(env.submit_prices(&[(&nodes[0], m, 210 * ONE, t), (&outsider, m, 999 * ONE, t)]), "NotEnoughSignatures");
    assert_err(env.submit_prices(&[(&nodes[0], m, 210 * ONE, t - 181), (&nodes[1], m, 212 * ONE, t)]), "ReportOutOfWindow");
    let other = Pubkey::new_unique();
    assert_err(env.submit_prices(&[(&nodes[0], other, 210 * ONE, t), (&nodes[1], other, 212 * ONE, t)]), "NotEnoughSignatures");

    env.submit_prices(&[(&nodes[0], m, 214 * ONE, t), (&nodes[1], m, 210 * ONE, t - 5), (&nodes[2], m, 212 * ONE, t)]).unwrap();
    let mk = env.get_market();
    assert_eq!((mk.price, mk.price_updated_at), (212 * ONE, t - 5)); // median, oldest time
    // A replay (or anything not newer than the stored price) is refused.
    assert_err(env.submit_prices(&[(&nodes[0], m, 300 * ONE, t - 5), (&nodes[1], m, 300 * ONE, t - 5)]), "ReportOutOfWindow");
    // A forged signature fails in the precompile itself.
    let mut bad = ed25519_ix(&[(&nodes[0], m, 220 * ONE, t + 1), (&nodes[1], m, 220 * ONE, t + 1)]);
    let last = bad.data.len() - 1;
    bad.data[last] ^= 1; // tamper with the second report's message after signing
    let k = env.keeper.insecure_clone();
    let metas = acc::SubmitPrices { oracle: pda(&[ORACLE_SEED]), market: m, instructions: INSTRUCTIONS_SYSVAR }.to_account_metas(None);
    assert!(env.send_with(vec![bad], ix::SubmitPrices {}.data(), metas, &[&k]).is_err());
}

#[test]
fn guardian_pauses_and_haircuts() {
    let mut env = Env::new();
    let a = env.admin.insecure_clone();
    let guardian = Keypair::new();
    env.send(
        ix::SetGuardian { guardian: guardian.pubkey() }.data(),
        acc::InitGuardian { admin: a.pubkey(), config: env.config, guardian_state: pda(&[GUARDIAN_SEED]), system_program: system_program::ID }.to_account_metas(None),
        &[&a],
    )
    .unwrap();
    let u = env.funded_user();
    env.guardian_act(ix::GuardianPause { borrow_paused: true, cover_paused: false }.data()).unwrap();
    assert_err(env.borrow(&u, ONE), "GuardianBorrowPaused");
    env.guardian_act(ix::GuardianPause { borrow_paused: false, cover_paused: false }.data()).unwrap();
    // A 10 pp haircut for an hour: the open limit falls from 60% to 50%.
    env.guardian_act(ix::GuardianHaircut { haircut_bps: 1_000, until: T0 + H }.data()).unwrap();
    assert_err(env.borrow(&u, 10_000 * ONE + 1), "BorrowLimitExceeded");
    env.borrow(&u, 10_000 * ONE).unwrap();
    assert_err(env.guardian_act(ix::GuardianHaircut { haircut_bps: 1_000, until: T0 + 8 * 24 * H }.data()), "InvalidHaircut");
    // A stranger can't act.
    let metas = acc::GuardianAct { authority: u.pubkey(), config: env.config, guardian_state: pda(&[GUARDIAN_SEED]) }.to_account_metas(None);
    assert_err(env.send(ix::GuardianPause { borrow_paused: true, cover_paused: true }.data(), metas, &[&u]), "NotGuardian");
}

#[test]
fn auto_cover_can_be_switched_off_per_loan() {
    let mut env = Env::new();
    fund_pool(&mut env, 50_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap(); // 60%: coverable, above the 40% safe LTV
    env.open_epoch().unwrap();
    env.set_auto_cover(&u, false).unwrap();
    let marker = pda(&[NO_AUTOCOVER_SEED, env.position(&u.pubkey()).as_ref()]);
    assert!(env.svm.get_account(&marker).is_some());
    env.at(T0 + 5 * H - 14 * 60); // after the Bell deadline
    assert_err(env.write_cover(&u, 0, true, true), "AutoCoverOff");
    env.flag(KIND_PRECLOSE, &u.pubkey(), 1).unwrap(); // sold down before the close instead
    // Back on: the marker closes and its rent returns.
    let before = env.svm.get_balance(&u.pubkey()).unwrap();
    env.set_auto_cover(&u, true).unwrap();
    assert!(env.svm.get_account(&marker).map_or(true, |a| a.lamports == 0));
    assert!(env.svm.get_balance(&u.pubkey()).unwrap() > before - 10_000);
}

// ───────────── emergency auctions, backstop inventory, T-Bill redemptions ─────────────

/// An unbid INTRADAY lot the pool backstops at the reserve (150 USDC, κ = 0 in the test config); returns its size.
fn backstop_lot(env: &mut Env) -> u64 {
    fund_pool(env, 50_000 * ONE);
    let u = env.funded_user();
    env.borrow(&u, 12_000 * ONE).unwrap();
    env.set_price(150 * ONE).unwrap();
    env.flag(KIND_INTRADAY, &u.pubkey(), 1).unwrap();
    set_time(&mut env.svm, T0 + 15);
    env.fix(&u.pubkey(), 1).unwrap();
    set_time(&mut env.svm, T0 + 60);
    env.clear(1, &[]).unwrap();
    env.settle_lot(&u.pubkey(), 1).unwrap();
    env.get_auction(1).lot
}

#[test]
fn emergency_auction_runs_in_extended_hours() {
    // Pre-market of the calendar's first session, no closure pending: the clock reads EXTENDED. (Inside a
    // scheduled closure pre/post-market counts as the closure, so EXTENDED is reached only outside one.)
    let mut env = Env::build(1_000_000 * ONE, T0 - 2 * H);
    assert_eq!(env.get_clock().state, ClockState::Extended);
    fund_pool(&mut env, 50_000 * ONE);
    let u = env.funded_user();
    env.set_price(200 * ONE).unwrap();
    assert_err(env.flag(KIND_EMERGENCY, &u.pubkey(), 1), "NotLiquidatable"); // no debt yet
    let v = env.funded_user();
    // Borrowing outside the regular session uses the closed LTV (40%).
    env.borrow(&v, 7_900 * ONE).unwrap();
    env.set_price(100 * ONE).unwrap(); // 7,900 > 10,000 × 75%
    assert_err(env.flag(KIND_INTRADAY, &v.pubkey(), 1), "MarketNotOpen");
    env.flag(KIND_EMERGENCY, &v.pubkey(), 1).unwrap();
    let a = env.get_auction(1);
    let t = T0 - 2 * H;
    assert_eq!((a.kind, a.deadlines[0] - t, a.deadlines[3] - t, a.nav), (KIND_EMERGENCY, 60, 300, false));
    set_time(&mut env.svm, t + 60);
    env.fix(&v.pubkey(), 1).unwrap();
    set_time(&mut env.svm, t + 300);
    env.clear(1, &[]).unwrap();
    let a = env.get_auction(1);
    assert!(a.lot > 0 && a.q_pool == a.lot);
    env.settle_lot(&v.pubkey(), 1).unwrap();
    assert!(env.debt(&v.pubkey()) < 7_900 * ONE);
    let _ = u;
}

#[test]
fn backstop_inventory_counts_in_nav_and_resells_by_gda() {
    let mut env = Env::new();
    let lot = backstop_lot(&mut env);
    let a = env.get_auction(1);
    let inv = env.get_inventory();
    assert_eq!((inv.qty, inv.cost, inv.nav), (lot, a.pool_paid, false));
    assert_eq!(inv.mark, a.pool_paid); // κ = 0: worth V = what the pool paid
    let p = env.get_pool();
    assert_eq!((p.inventory_mark, p.nav()), (inv.mark, p.free_cash() + inv.mark));

    // Marked down with the price, never above cost.
    env.set_price(120 * ONE).unwrap();
    env.mark_inventory().unwrap();
    assert_eq!(env.get_inventory().mark, lot * 120);
    env.set_price(180 * ONE).unwrap();
    env.mark_inventory().unwrap();
    assert_eq!(env.get_inventory().mark, inv.cost);
    env.set_price(150 * ONE).unwrap();

    // GDA: k = 1.02 × V, inventory emitted over 3 days.
    env.resell().unwrap();
    let g = env.get_inventory().gda;
    assert!(g.active);
    assert_eq!((g.k, g.qty, g.emission_per_sec), (153 * ONE, lot, lot / (3 * 86_400)));
    assert_err(env.resell(), "GdaRunning");
    let buyer = env.bidder(100_000 * ONE);
    let q = lot / 4;
    assert_err(env.gda_buy(&buyer, q, 1), "CostAboveMax");
    let cash0 = env.get_pool().cash;
    env.gda_buy(&buyer, q, u64::MAX).unwrap();
    let paid = env.get_pool().cash - cash0;
    assert!(paid >= q * 150, "paid {paid} for {q}"); // never below (1 − κ) × V
    assert_eq!(env.balance(&buyer.pubkey(), &env.stock_mint.clone()), q);
    let inv = env.get_inventory();
    assert_eq!((inv.qty, inv.gda.sold), (lot - q, q));
    assert_eq!(inv.cost, a.pool_paid - a.pool_paid * q / lot);

    // After the close nobody can buy; ending early is for the keeper or admin.
    env.at(T0 + 5 * H + 60);
    assert_err(env.gda_buy(&buyer, q, u64::MAX), "MarketNotOpen");
    let stranger = env.user();
    assert_err(env.close_gda(&stranger), "GdaStillRunning");
    let k = env.keeper.insecure_clone();
    env.close_gda(&k).unwrap();
    assert!(!env.get_inventory().gda.active);
    assert_eq!(env.balance(&env.pool(), &env.stock_mint.clone()), lot - q); // unsold units stay with the pool
}

#[test]
fn tbill_backstop_is_redeemed_with_the_fund() {
    let mut env = Env::build_venue(1_000_000 * ONE, T0, VENUE_USBANK);
    let lot = backstop_lot(&mut env);
    let a = env.get_auction(1);
    assert!(a.nav);
    assert_eq!(a.reserve, 150 * ONE * 995 / 1_000); // κ_nav = 0.5%
    let inv = env.get_inventory();
    assert!(inv.nav && inv.qty == lot);
    assert_err(env.resell(), "NavInventory");

    let nav0 = env.get_pool().nav();
    env.request_redemption().unwrap();
    let p = env.get_pool();
    assert_eq!((p.claims_cost, p.inventory_mark, p.redemptions), (inv.cost, 0, 1));
    assert_eq!(p.nav(), nav0); // the claim is carried at cost
    assert_eq!(env.balance(&env.pool(), &env.stock_mint.clone()), 0); // the fund took the tokens
    assert_err(env.request_redemption(), "NoInventory");
    assert_err(env.claim_redemption(1), "RedemptionNotReady");

    set_time(&mut env.svm, T0 + 60 + REDEMPTION_DELAY);
    let cash0 = env.get_pool().cash;
    env.claim_redemption(1).unwrap();
    let r = env.get_redemption(1);
    assert!(r.claimed);
    assert_eq!(r.assets, lot * 150); // qty × the fund's NAV
    let p = env.get_pool();
    assert_eq!((p.cash - cash0, p.claims_cost), (r.assets, 0));
    assert!(r.assets > r.cost); // the κ_nav discount is the pool's gain
    assert_err(env.claim_redemption(1), "NothingToClaim");
}

#[test]
fn migrate_pool_grows_an_old_pool() {
    let mut env = Env::new();
    fund_pool(&mut env, 1_000 * ONE);
    // Shrink the pool to the size it had before the inventory fields.
    let key = env.pool();
    let mut acct = env.svm.get_account(&key).unwrap();
    let new_len = acct.data.len();
    acct.data.truncate(new_len - 24);
    env.svm.set_account(key, acct).unwrap();
    let a = env.admin.insecure_clone();
    let metas = acc::MigratePool { admin: a.pubkey(), config: env.config, pool: key, system_program: system_program::ID }.to_account_metas(None);
    env.send(ix::MigratePool {}.data(), metas.clone(), &[&a]).unwrap();
    assert_eq!(env.svm.get_account(&key).unwrap().data.len(), new_len);
    assert_eq!(env.get_pool().nav(), 1_000 * ONE);
    assert_err(env.send(ix::MigratePool {}.data(), metas, &[&a]), "AlreadyMigrated");
}

#[test]
fn settled_epoch_market_is_closed_and_its_rent_returned() {
    let mut env = Env::new();
    fund_pool(&mut env, 50_000 * ONE);
    let seq = env.open_epoch().unwrap();
    let em = env.epoch_market(seq);
    let close = |env: &mut Env, receiver: Pubkey| {
        let k = env.keeper.insecure_clone();
        let metas = acc::CloseEpochMarket { config: env.config, epoch: env.epoch(seq), epoch_market: em, keeper: receiver }.to_account_metas(None);
        env.send(ix::CloseEpochMarket {}.data(), metas, &[&k])
    };
    let keeper = env.keeper.pubkey();
    assert_err(close(&mut env, keeper), "EpochNotReady"); // still open: covers and capacity read it
    env.at(T0 + 5 * H - 10 * 60);
    env.snapshot_epoch().unwrap();
    env.at(T0 + 23 * H + 60);
    env.at(T0 + 23 * H + 60 + TIMINGS_REOPEN[0]);
    env.complete_reopen().unwrap();
    set_time(&mut env.svm, T0 + 23 * H + 60 + REOPEN_WINDOW_SECS + SETTLE_DELAY_SECS);
    env.settle_epoch().unwrap();
    let stranger = env.user().pubkey();
    assert_err(close(&mut env, stranger), "NotKeeper"); // the rent only goes back to the keeper
    let rent = env.svm.get_account(&em).unwrap().lamports;
    let before = env.svm.get_account(&keeper).unwrap().lamports;
    close(&mut env, keeper).unwrap();
    assert!(env.svm.get_account(&em).map_or(true, |a| a.lamports == 0));
    let after = env.svm.get_account(&keeper).unwrap().lamports;
    assert_eq!(after, before + rent - 5_000); // the rent, less this transaction's fee
    assert_eq!(env.get_epoch(seq).phase, EPOCH_SETTLED); // the epoch itself stays for ticket claims
}
