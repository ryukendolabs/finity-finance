//! End-to-end tests of the compiled programs in LiteSVM, with real token transfers: the loan in SPL Token (USD, 6
//! decimals), AAPL collateral in the real AAPLx mint (Token-2022, 8 decimals, permanent delegate, transfer-hook and
//! metadata extensions; copied from mainnet into tests/fixtures with only the mint authority replaced), TSLA in SPL
//! Token. Token accounts are created through the associated token account program, as the app does.
//!
//! Build the three variants first (deploy.sh does this):
//!   cargo build-sbf                                                  # live    → target/deploy
//!   cargo build-sbf --features teardown -- --target-dir target/td    # teardown → target/td/deploy
//!   cargo build-sbf --features full -- --target-dir target/full      # full    → target/full/deploy

use {
    finity_lend::*,
    litesvm::LiteSVM,
    litesvm_token::{CreateAccount, CreateMint, MintTo},
    solana_address::Address,
    solana_clock::Clock,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_system_interface::instruction::create_account,
    solana_transaction::versioned::VersionedTransaction,
};

const LIVE: &[u8] = include_bytes!("../target/deploy/finity_lend.so");
const TEARDOWN: &[u8] = include_bytes!("../target/td/deploy/finity_lend.so");
const FULL: &[u8] = include_bytes!("../target/full/deploy/finity_lend.so");

const T0: i64 = 1_800_000_000;
const USD: u64 = 1_000_000;
/// One AAPL (Token-2022, 8 decimals).
const SHARE: u64 = 100_000_000;
/// A price per whole AAPL, as posted: per 10⁶ base units, i.e. ÷100 for 8 decimals.
const fn aapl_px(usd: u64) -> u64 {
    usd * USD / 100
}

fn token() -> Address {
    TOKEN_PROGRAM
}
fn t22() -> Address {
    TOKEN_2022
}

/// The real AAPLx mint account (mainnet XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp).
const AAPLX_MINT: &[u8] = include_bytes!("fixtures/aaplx_mint.bin");
const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Puts AAPLx at its mainnet address with `authority` as its mint authority (the rest unchanged).
fn load_aaplx(svm: &mut LiteSVM, authority: &Address) -> Address {
    let mint = Address::from_str_const("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp");
    let mut data = AAPLX_MINT.to_vec();
    assert_eq!(&data[0..4], &[1, 0, 0, 0], "mint authority set");
    data[4..36].copy_from_slice(authority.as_ref());
    assert_eq!(data[44], 8, "decimals");
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(mint, solana_account::Account { lamports, data, owner: TOKEN_2022, executable: false, rent_epoch: 0 })
        .unwrap();
    mint
}

/// Creates `owner`'s associated token account for a Token-2022 `mint` (sized for the mint's extensions).
fn ata_2022(svm: &mut LiteSVM, payer: &Keypair, owner: &Address, mint: &Address) -> Address {
    let (ata, _) = Address::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM);
    let ix = Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: vec![1],
    };
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx).unwrap();
    ata
}

struct Env {
    svm: LiteSVM,
    pid: Address,
    admin: Keypair,
    user: Keypair,
    markets: Address,
    pda: Address,
    usd: Address,
    loan_vault: Address,
    aapl: Address,
    aapl_vault: Address,
    tsla_vault: Address,
    user_aapl: Address,
    user_usd: Address,
}

fn set_time(svm: &mut LiteSVM, ts: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = ts;
    svm.set_sysvar(&c);
}

fn code(res: Result<(), String>, c: u32) {
    let e = res.expect_err("expected failure");
    assert!(e.contains(&format!("Custom({c})")), "expected Custom({c}) in:\n{e}");
}

impl Env {
    /// Two markets (AAPL 50% max LTV, TSLA 40%), a loan vault holding $100,000 and a user with 100 AAPL. Prices are
    /// posted: AAPL $200, TSLA $300 (6 decimals).
    fn new(program: &[u8]) -> Self {
        let mut svm = LiteSVM::new();
        let pid = Address::new_unique();
        svm.add_program(pid, program).unwrap();
        let (admin, user) = (Keypair::new(), Keypair::new());
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&user.pubkey(), 10_000_000_000).unwrap();
        set_time(&mut svm, T0);

        let markets_kp = Keypair::new();
        let markets = markets_kp.pubkey();
        let (pda, bump) = Address::find_program_address(&[VAULT_SEED, markets.as_ref()], &pid);

        let usd = CreateMint::new(&mut svm, &admin).decimals(6).token_program_id(&TOKEN_PROGRAM).send().unwrap();
        let t = t22();
        let aapl = load_aaplx(&mut svm, &admin.pubkey());
        let tsla = CreateMint::new(&mut svm, &admin).decimals(6).token_program_id(&TOKEN_PROGRAM).send().unwrap();
        let loan_vault = CreateAccount::new(&mut svm, &admin, &usd).owner(&pda).token_program_id(&TOKEN_PROGRAM).send().unwrap();
        let aapl_vault = ata_2022(&mut svm, &admin, &pda, &aapl);
        let tsla_vault = CreateAccount::new(&mut svm, &admin, &tsla).owner(&pda).token_program_id(&TOKEN_PROGRAM).send().unwrap();
        let user_aapl = ata_2022(&mut svm, &user, &user.pubkey(), &aapl);
        let user_usd = CreateAccount::new(&mut svm, &user, &usd).owner(&user.pubkey()).token_program_id(&TOKEN_PROGRAM).send().unwrap();
        MintTo::new(&mut svm, &admin, &usd, &loan_vault, 100_000 * USD).token_program_id(&TOKEN_PROGRAM).send().unwrap();
        MintTo::new(&mut svm, &admin, &aapl, &user_aapl, 100 * SHARE).token_program_id(&t).send().unwrap();

        let mut e = Env {
            svm,
            pid,
            admin,
            user,
            markets,
            pda,
            usd,
            loan_vault,
            aapl,
            aapl_vault,
            tsla_vault,
            user_aapl,
            user_usd,
        };
        let a = e.admin.insecure_clone();
        let rent = e.svm.minimum_balance_for_rent_exemption(MARKETS_LEN);
        let create = create_account(&a.pubkey(), &markets, rent, MARKETS_LEN as u64, &pid);
        let init = e.ix(
            vec![IX_INIT, bump],
            vec![
                AccountMeta::new(markets, true),
                AccountMeta::new_readonly(a.pubkey(), true),
                AccountMeta::new_readonly(loan_vault, false),
            ],
        );
        e.send(vec![create, init], &[&a, &markets_kp]).unwrap();
        e.add_market(b"AAPL", 5000, aapl_vault).unwrap();
        e.add_market(b"TSLA", 4000, tsla_vault).unwrap();
        e.prices(&[aapl_px(200), 300 * USD]).unwrap();
        e
    }

    fn send(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair]) -> Result<(), String> {
        let msg = Message::new_with_blockhash(&ixs, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let r = self
            .svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.svm.expire_blockhash();
        r
    }

    fn ix(&self, data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
        Instruction { program_id: self.pid, accounts: metas, data }
    }

    fn add_market_as(&mut self, who: &Keypair, ticker: &[u8], max: u16, vault: Address) -> Result<(), String> {
        let mut t = [0u8; 8];
        t[..ticker.len()].copy_from_slice(ticker);
        let data = [&[IX_ADD_MARKET][..], &t, &max.to_le_bytes()].concat();
        let ix = self.ix(
            data,
            vec![
                AccountMeta::new(self.markets, false),
                AccountMeta::new_readonly(who.pubkey(), true),
                AccountMeta::new_readonly(vault, false),
            ],
        );
        self.send(vec![ix], &[who])
    }

    fn add_market(&mut self, ticker: &[u8], max: u16, vault: Address) -> Result<(), String> {
        let a = self.admin.insecure_clone();
        self.add_market_as(&a, ticker, max, vault)
    }

    fn prices_as(&mut self, who: &Keypair, prices: &[u64]) -> Result<(), String> {
        let mut data = vec![IX_POST_PRICES];
        for p in prices {
            data.extend_from_slice(&p.to_le_bytes());
        }
        let ix = self.ix(
            data,
            vec![AccountMeta::new(self.markets, false), AccountMeta::new_readonly(who.pubkey(), true)],
        );
        self.send(vec![ix], &[who])
    }

    fn prices(&mut self, prices: &[u64]) -> Result<(), String> {
        let a = self.admin.insecure_clone();
        self.prices_as(&a, prices)
    }

    /// The accounts of borrow / repay / withdraw / liquidate, with the default vaults and token accounts.
    fn position_metas(&self, pos: &Address, pos_signs: bool, user: &Address) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(*pos, pos_signs),
            AccountMeta::new_readonly(self.markets, false),
            AccountMeta::new_readonly(*user, true),
            AccountMeta::new(self.user_aapl, false),
            AccountMeta::new(self.aapl_vault, false),
            AccountMeta::new(self.user_usd, false),
            AccountMeta::new(self.loan_vault, false),
            AccountMeta::new_readonly(self.pda, false),
            AccountMeta::new_readonly(self.aapl, false),
            AccountMeta::new_readonly(self.usd, false),
            AccountMeta::new_readonly(token(), false),
            AccountMeta::new_readonly(t22(), false),
        ]
    }

    /// Opens a position (market `idx`) with a borrow.
    fn open(&mut self, pos: &Keypair, idx: u8, coll: u64, loan: u64) -> Result<(), String> {
        let u = self.user.insecure_clone();
        let rent = self.svm.minimum_balance_for_rent_exemption(POSITION_LEN);
        let create = create_account(&u.pubkey(), &pos.pubkey(), rent, POSITION_LEN as u64, &self.pid);
        let data = [&[IX_BORROW, idx][..], &coll.to_le_bytes(), &loan.to_le_bytes()].concat();
        let ix = self.ix(data, self.position_metas(&pos.pubkey(), true, &u.pubkey()));
        self.send(vec![create, ix], &[&u, pos])
    }

    fn borrow(&mut self, pos: &Address, coll: u64, loan: u64) -> Result<(), String> {
        let u = self.user.insecure_clone();
        let data = [&[IX_BORROW, 0][..], &coll.to_le_bytes(), &loan.to_le_bytes()].concat();
        let ix = self.ix(data, self.position_metas(pos, false, &u.pubkey()));
        self.send(vec![ix], &[&u])
    }

    fn repay(&mut self, pos: &Address, amount: u64) -> Result<(), String> {
        let u = self.user.insecure_clone();
        let ix = self.ix([&[IX_REPAY][..], &amount.to_le_bytes()].concat(), self.position_metas(pos, false, &u.pubkey()));
        self.send(vec![ix], &[&u])
    }

    fn close(&mut self, acc: &Address, who: &Keypair) -> Result<(), String> {
        let ix = self.ix(vec![IX_CLOSE], vec![AccountMeta::new(*acc, false), AccountMeta::new(who.pubkey(), true)]);
        self.send(vec![ix], &[who])
    }

    /// `program` and `mint` are the vault's.
    fn vault_admin(&mut self, who: &Keypair, vault: Address, dest: Address, op: u8, amount: u64) -> Result<(), String> {
        let (program, mint) = if vault == self.aapl_vault { (t22(), self.aapl) } else { (token(), self.usd) };
        let data = [&[IX_VAULT_ADMIN, op][..], &amount.to_le_bytes()].concat();
        let ix = self.ix(
            data,
            vec![
                AccountMeta::new_readonly(self.markets, false),
                AccountMeta::new(who.pubkey(), true),
                AccountMeta::new(vault, false),
                AccountMeta::new(dest, false),
                AccountMeta::new_readonly(self.pda, false),
                AccountMeta::new_readonly(program, false),
                AccountMeta::new_readonly(mint, false),
            ],
        );
        self.send(vec![ix], &[who])
    }

    fn balance(&self, a: &Address) -> u64 {
        let d = self.svm.get_account(a).unwrap().data;
        u64::from_le_bytes(d[64..72].try_into().unwrap())
    }

    fn position(&self, p: &Address) -> (u64, u64) {
        let d = self.svm.get_account(p).unwrap().data;
        (
            u64::from_le_bytes(d[P_COLL..P_COLL + 8].try_into().unwrap()),
            u64::from_le_bytes(d[P_DEBT..P_DEBT + 8].try_into().unwrap()),
        )
    }

    fn gone(&self, a: &Address) -> bool {
        self.svm.get_account(a).map_or(true, |a| a.lamports == 0)
    }
}

#[test]
fn setup_and_prices() {
    let mut e = Env::new(LIVE);
    let d = e.svm.get_account(&e.markets).unwrap().data;
    assert_eq!(d[0], TAG_MARKETS);
    assert_eq!(d[H_COUNT], 2);
    assert_eq!(&d[H_AUTH..H_AUTH + 32], e.admin.pubkey().as_ref());
    assert_eq!(&d[H_LOAN_VAULT..H_LOAN_VAULT + 32], e.loan_vault.as_ref());
    let tsla = H_LEN + MKT_LEN;
    assert_eq!(&d[tsla + MKT_TICKER..tsla + MKT_TICKER + 4], b"TSLA");
    assert_eq!(&d[tsla + MKT_VAULT..tsla + MKT_VAULT + 32], e.tsla_vault.as_ref());
    assert_eq!(u64::from_le_bytes(d[tsla + MKT_PRICE..tsla + MKT_PRICE + 8].try_into().unwrap()), 300 * USD);
    assert_eq!(u16::from_le_bytes(d[tsla + MKT_MAX..tsla + MKT_MAX + 2].try_into().unwrap()), 4000);
    assert_eq!(i64::from_le_bytes(d[H_PRICE_AT..H_PRICE_AT + 8].try_into().unwrap()), T0);

    // Only the authority; one price per market; sane LTVs; at most MAX_MARKETS markets.
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    code(e.prices_as(&stranger, &[1, 1]), UNAUTHORIZED);
    code(e.add_market_as(&stranger, b"X", 5000, e.aapl_vault), UNAUTHORIZED);
    code(e.prices(&[1]), BAD_INSTRUCTION);
    code(e.prices(&[1, 1, 1]), BAD_INSTRUCTION);
    code(e.add_market(b"X", 0, e.aapl_vault), BAD_PARAMS);
    code(e.add_market(b"X", 10_000, e.aapl_vault), BAD_PARAMS);
    for _ in 2..MAX_MARKETS {
        e.add_market(b"X", 5000, e.aapl_vault).unwrap();
    }
    code(e.add_market(b"X", 5000, e.aapl_vault), BAD_PARAMS);

    // A second init of the same account fails.
    let a = e.admin.insecure_clone();
    let ix = e.ix(
        vec![IX_INIT, 255],
        vec![
            AccountMeta::new(e.markets, false),
            AccountMeta::new_readonly(a.pubkey(), true),
            AccountMeta::new_readonly(e.loan_vault, false),
        ],
    );
    code(e.send(vec![ix], &[&a]), UNAUTHORIZED); // the markets account must sign
}

#[test]
fn borrow_and_repay() {
    let mut e = Env::new(LIVE);
    let pos = Keypair::new();
    let p = pos.pubkey();
    // 10 AAPL × $200 = $2,000; 50% → $1,000.
    code(e.open(&pos, 0, 10 * SHARE, 1_000 * USD + 1), OVER_LIMIT);
    e.open(&pos, 0, 10 * SHARE, 1_000 * USD).unwrap();
    assert_eq!(e.position(&p), (10 * SHARE, 1_000 * USD));
    assert_eq!(e.balance(&e.user_aapl), 90 * SHARE);
    assert_eq!(e.balance(&e.aapl_vault), 10 * SHARE);
    assert_eq!(e.balance(&e.user_usd), 1_000 * USD);
    assert_eq!(e.balance(&e.loan_vault), 99_000 * USD);

    // Topping up: more collateral and more loan, within the limit again.
    code(e.borrow(&p, 0, 1), OVER_LIMIT);
    e.borrow(&p, 5 * SHARE, 500 * USD).unwrap();
    assert_eq!(e.position(&p), (15 * SHARE, 1_500 * USD));
    // Collateral only (no price needed for that alone).
    e.borrow(&p, 1 * SHARE, 0).unwrap();
    assert_eq!(e.position(&p), (16 * SHARE, 1_500 * USD));

    // Repaying more than owed fails; a partial repayment keeps the collateral locked.
    code(e.repay(&p, 1_500 * USD + 1), BAD_PARAMS);
    e.repay(&p, 600 * USD).unwrap();
    assert_eq!(e.position(&p), (16 * SHARE, 900 * USD));
    assert_eq!(e.balance(&e.user_aapl), 84 * SHARE);
    // A non-empty position cannot be closed.
    let u = e.user.insecure_clone();
    code(e.close(&p, &u), BAD_PARAMS);

    // Paying off returns all the collateral.
    e.repay(&p, 900 * USD).unwrap();
    assert_eq!(e.position(&p), (0, 0));
    assert_eq!(e.balance(&e.user_aapl), 100 * SHARE);
    assert_eq!(e.balance(&e.aapl_vault), 0);
    assert_eq!(e.balance(&e.user_usd), 0);
    assert_eq!(e.balance(&e.loan_vault), 100_000 * USD);

    // The owner closes the empty position and gets the rent back.
    let before = e.svm.get_balance(&u.pubkey()).unwrap();
    let rent = e.svm.get_balance(&p).unwrap();
    e.close(&p, &u).unwrap();
    assert!(e.gone(&p));
    assert_eq!(e.svm.get_balance(&u.pubkey()).unwrap(), before + rent - 5_000);
}

#[test]
fn prices_gate_borrowing_not_repaying() {
    let mut e = Env::new(LIVE);
    let pos = Keypair::new();
    let p = pos.pubkey();
    e.open(&pos, 0, 10 * SHARE, 500 * USD).unwrap();

    // A price older than MAX_PRICE_AGE_SECS blocks new loans; repaying still works.
    set_time(&mut e.svm, T0 + MAX_PRICE_AGE_SECS + 1);
    code(e.borrow(&p, 0, 1), STALE_PRICE);
    e.repay(&p, 100 * USD).unwrap();
    e.prices(&[aapl_px(200), 300 * USD]).unwrap();
    e.borrow(&p, 0, 100 * USD).unwrap();

    // A zero price pauses borrowing in that market.
    e.prices(&[0, 300 * USD]).unwrap();
    code(e.borrow(&p, 0, 1), OVER_LIMIT);
    e.repay(&p, 500 * USD).unwrap();
    assert_eq!(e.position(&p), (0, 0));
}

#[test]
fn rejects_wrong_accounts() {
    let mut e = Env::new(LIVE);
    let pos = Keypair::new();
    let p = pos.pubkey();
    e.open(&pos, 0, 10 * SHARE, 500 * USD).unwrap();
    let u = e.user.insecure_clone();
    let borrow = |amount: u64| [&[IX_BORROW, 0][..], &0u64.to_le_bytes(), &amount.to_le_bytes()].concat();

    // Another market's vault, or a loan vault that is not the registered one.
    let mut metas = e.position_metas(&p, false, &u.pubkey());
    metas[4] = AccountMeta::new(e.tsla_vault, false);
    let ix = e.ix(borrow(1), metas);
    code(e.send(vec![ix], &[&u]), BAD_ACCOUNT);
    let fake_vault = CreateAccount::new(&mut e.svm, &u, &e.usd).owner(&u.pubkey()).token_program_id(&TOKEN_PROGRAM).send().unwrap();
    let mut metas = e.position_metas(&p, false, &u.pubkey());
    metas[6] = AccountMeta::new(fake_vault, false);
    let ix = e.ix(borrow(1), metas);
    code(e.send(vec![ix], &[&u]), BAD_ACCOUNT);

    // A program other than the token programs, or the loan's token program missing.
    let mut metas = e.position_metas(&p, false, &u.pubkey());
    metas[10] = AccountMeta::new_readonly(e.pid, false);
    let ix = e.ix(borrow(1), metas);
    code(e.send(vec![ix], &[&u]), BAD_ACCOUNT);
    let mut metas = e.position_metas(&p, false, &u.pubkey());
    metas.remove(10);
    let ix = e.ix(borrow(1), metas);
    code(e.send(vec![ix], &[&u]), BAD_ACCOUNT);
    // The collateral's (Token-2022) program missing: depositing fails.
    let mut metas = e.position_metas(&p, false, &u.pubkey());
    metas.pop();
    let ix = e.ix([&[IX_BORROW, 0][..], &SHARE.to_le_bytes(), &0u64.to_le_bytes()].concat(), metas);
    code(e.send(vec![ix], &[&u]), BAD_ACCOUNT);
    // The wrong mint: the token program refuses the transfer.
    let mut metas = e.position_metas(&p, false, &u.pubkey());
    metas[9] = AccountMeta::new_readonly(e.aapl, false);
    metas[8] = AccountMeta::new_readonly(e.usd, false);
    let ix = e.ix(borrow(1), metas);
    assert!(e.send(vec![ix], &[&u]).is_err());

    // The same account twice (the collateral vault as the user's own token account).
    let mut metas = e.position_metas(&p, false, &u.pubkey());
    metas[3] = AccountMeta::new(e.aapl_vault, false);
    let ix = e.ix(borrow(0), metas);
    code(e.send(vec![ix], &[&u]), BAD_ACCOUNT);

    // Someone else cannot borrow on, repay into or close the position.
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = e.ix(borrow(1), e.position_metas(&p, false, &stranger.pubkey()));
    code(e.send(vec![ix], &[&stranger]), UNAUTHORIZED);
    let ix = e.ix([&[IX_REPAY][..], &0u64.to_le_bytes()].concat(), e.position_metas(&p, false, &stranger.pubkey()));
    code(e.send(vec![ix], &[&stranger]), UNAUTHORIZED);
    code(e.close(&p, &stranger), UNAUTHORIZED);

    // Opening needs the new position account's signature and a market that exists.
    let victim = Keypair::new();
    let rent = e.svm.minimum_balance_for_rent_exemption(POSITION_LEN);
    let create = create_account(&u.pubkey(), &victim.pubkey(), rent, POSITION_LEN as u64, &e.pid);
    e.send(vec![create], &[&u, &victim]).unwrap();
    let ix = e.ix(borrow(0), e.position_metas(&victim.pubkey(), false, &u.pubkey()));
    code(e.send(vec![ix], &[&u]), UNAUTHORIZED);
    code(e.open(&Keypair::new(), 2, SHARE, 0), BAD_PARAMS);
    // Repay cannot open a position.
    let ix = e.ix([&[IX_REPAY][..], &0u64.to_le_bytes()].concat(), e.position_metas(&victim.pubkey(), true, &u.pubkey()));
    code(e.send(vec![ix], &[&u, &victim]), BAD_ACCOUNT);

    // The vault authority must be the real one, or the token program refuses the payout.
    let mut metas = e.position_metas(&p, false, &u.pubkey());
    metas[7] = AccountMeta::new_readonly(u.pubkey(), false);
    let ix = e.ix(borrow(1), metas);
    assert!(e.send(vec![ix], &[&u]).is_err());

    // The markets account in place of a position, and the reverse.
    let ix = e.ix(borrow(0), e.position_metas(&e.markets, false, &u.pubkey()));
    code(e.send(vec![ix], &[&u]), BAD_ACCOUNT);

    // Unknown or left-out instructions, wrong argument lengths, too few accounts.
    for ixn in [IX_VAULT_ADMIN, IX_WITHDRAW, IX_LIQUIDATE, 99] {
        let ix = e.ix(vec![ixn], vec![AccountMeta::new(p, false), AccountMeta::new(u.pubkey(), true)]);
        code(e.send(vec![ix], &[&u]), BAD_INSTRUCTION);
    }
    let ix = e.ix(vec![IX_REPAY, 1], e.position_metas(&p, false, &u.pubkey()));
    code(e.send(vec![ix], &[&u]), BAD_INSTRUCTION);
    let ix = e.ix(vec![IX_CLOSE], vec![AccountMeta::new(p, false)]);
    code(e.send(vec![ix], &[&u]), BAD_ACCOUNT);

    // The live build cannot close the markets account.
    let a = e.admin.insecure_clone();
    code(e.close(&e.markets.clone(), &a), BAD_ACCOUNT);

    // None of this moved anything.
    assert_eq!(e.position(&p), (10 * SHARE, 500 * USD));
    assert_eq!(e.balance(&e.aapl_vault), 10 * SHARE);
    assert_eq!(e.balance(&e.loan_vault), 99_500 * USD);
}

#[test]
fn teardown_returns_everything() {
    let mut e = Env::new(LIVE);
    let pos = Keypair::new();
    let p = pos.pubkey();
    e.open(&pos, 0, 10 * SHARE, 500 * USD).unwrap();

    // Upgrade to the teardown build: borrowing stops, the authority empties and closes the vaults.
    e.svm.add_program(e.pid, TEARDOWN).unwrap();
    code(e.borrow(&p, 0, 1), BAD_INSTRUCTION);
    code(e.repay(&p, 1), BAD_INSTRUCTION);

    let a = e.admin.insecure_clone();
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let admin_usd = CreateAccount::new(&mut e.svm, &a, &e.usd).owner(&a.pubkey()).token_program_id(&TOKEN_PROGRAM).send().unwrap();
    code(e.vault_admin(&stranger, e.loan_vault, admin_usd, 0, 1), UNAUTHORIZED);
    code(e.vault_admin(&a, e.loan_vault, admin_usd, 2, 0), BAD_PARAMS);

    // Collateral goes back to its owner, the loan money to the authority.
    e.vault_admin(&a, e.aapl_vault, e.user_aapl, 0, 10 * SHARE).unwrap();
    e.vault_admin(&a, e.loan_vault, admin_usd, 0, 99_500 * USD).unwrap();
    assert_eq!(e.balance(&e.user_aapl), 100 * SHARE);
    assert_eq!(e.balance(&admin_usd), 99_500 * USD);

    // Empty vaults close and their rent goes to the authority; a non-empty one cannot.
    let t = t22();
    MintTo::new(&mut e.svm, &a, &e.aapl, &e.aapl_vault, 1).token_program_id(&t).send().unwrap();
    assert!(e.vault_admin(&a, e.aapl_vault, e.user_aapl, 1, 0).is_err());
    e.vault_admin(&a, e.aapl_vault, e.user_aapl, 0, 1).unwrap();
    for v in [e.aapl_vault, e.tsla_vault, e.loan_vault] {
        let (before, rent) = (e.svm.get_balance(&a.pubkey()).unwrap(), e.svm.get_balance(&v).unwrap());
        e.vault_admin(&a, v, e.user_aapl, 1, 0).unwrap();
        assert_eq!(e.svm.get_balance(&a.pubkey()).unwrap(), before + rent - 5_000);
        assert!(e.gone(&v));
    }

    // The owner closes the position although it still holds figures; the authority closes the markets.
    let u = e.user.insecure_clone();
    code(e.close(&p, &stranger), UNAUTHORIZED);
    e.close(&p, &u).unwrap();
    code(e.close(&e.markets.clone(), &u), UNAUTHORIZED);
    e.close(&e.markets.clone(), &a).unwrap();
    assert!(e.gone(&p) && e.gone(&e.markets));
}

#[test]
fn full_build_withdraws_and_liquidates() {
    let mut e = Env::new(FULL);
    let pos = Keypair::new();
    let p = pos.pubkey();
    e.open(&pos, 0, 10 * SHARE, 800 * USD).unwrap();
    let u = e.user.insecure_clone();
    let withdraw = |amount: u64| [&[IX_WITHDRAW][..], &amount.to_le_bytes()].concat();

    // Withdraw down to the limit: $800 at 50% needs $1,600 = 8 AAPL.
    let ix = e.ix(withdraw(2 * SHARE + 1), e.position_metas(&p, false, &u.pubkey()));
    code(e.send(vec![ix], &[&u]), OVER_LIMIT);
    let ix = e.ix(withdraw(2 * SHARE), e.position_metas(&p, false, &u.pubkey()));
    e.send(vec![ix], &[&u]).unwrap();
    assert_eq!(e.position(&p), (8 * SHARE, 800 * USD));

    // Within the limit it cannot be liquidated; after a drop to $150 (8 × $150 × 50% = $600 < $800) it can.
    let liq = Keypair::new();
    e.svm.airdrop(&liq.pubkey(), 1_000_000_000).unwrap();
    let liq_aapl = ata_2022(&mut e.svm, &liq, &liq.pubkey(), &e.aapl);
    let liq_usd = CreateAccount::new(&mut e.svm, &liq, &e.usd).owner(&liq.pubkey()).token_program_id(&TOKEN_PROGRAM).send().unwrap();
    let a = e.admin.insecure_clone();
    MintTo::new(&mut e.svm, &a, &e.usd, &liq_usd, 800 * USD).token_program_id(&TOKEN_PROGRAM).send().unwrap();
    let mut metas = e.position_metas(&p, false, &liq.pubkey());
    metas[3] = AccountMeta::new(liq_aapl, false);
    metas[5] = AccountMeta::new(liq_usd, false);
    let ix = e.ix(vec![IX_LIQUIDATE], metas.clone());
    code(e.send(vec![ix], &[&liq]), NOT_LIQUIDATABLE);
    e.prices(&[aapl_px(150), 300 * USD]).unwrap();
    let ix = e.ix(vec![IX_LIQUIDATE], metas);
    e.send(vec![ix], &[&liq]).unwrap();
    assert_eq!(e.position(&p), (0, 0));
    assert_eq!(e.balance(&liq_aapl), 8 * SHARE);
    assert_eq!(e.balance(&liq_usd), 0);
    assert_eq!(e.balance(&e.loan_vault), 100_000 * USD);
}

