//! End-to-end tests of the compiled program (target/deploy/finity_v2.so) in LiteSVM.
//! Run `cargo build-sbf` first.

use {
    finity_v2::*,
    litesvm::LiteSVM,
    solana_address::Address,
    solana_clock::Clock,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_system_interface::instruction::create_account,
    solana_transaction::versioned::VersionedTransaction,
};

const T0: i64 = 1_800_000_000;
const H: i64 = 3600;
const USD: u64 = 1_000_000;

struct Env {
    svm: LiteSVM,
    pid: Address,
    admin: Keypair,
    user: Keypair,
    market: Keypair,
}

fn set_time(svm: &mut LiteSVM, ts: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = ts;
    svm.set_sysvar(&c);
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let pid = Address::new_unique();
        svm.add_program(pid, include_bytes!("../target/deploy/finity_v2.so")).unwrap();
        let (admin, user, market) = (Keypair::new(), Keypair::new(), Keypair::new());
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&user.pubkey(), 10_000_000_000).unwrap();
        set_time(&mut svm, T0);
        let mut e = Env { svm, pid, admin, user, market };
        // AAPL: 75% max LTV, 55% closure-safe; open, closing in 5 hours (Bell at T0+3h), $200.
        e.init_market(*b"AAPL\0\0\0\0", 7500, 5500).unwrap();
        e.clock(OPEN, 5500, T0 + 5 * H, T0 + 21 * H).unwrap();
        e.price(200 * USD).unwrap();
        e
    }

    fn send(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair]) -> Result<(), String> {
        let msg = Message::new_with_blockhash(&ixs, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let r = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
        self.svm.expire_blockhash();
        r
    }

    fn ix(&self, data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
        Instruction { program_id: self.pid, accounts: metas, data }
    }

    fn create(&self, payer: &Keypair, acc: &Keypair) -> Instruction {
        let rent = self.svm.minimum_balance_for_rent_exemption(ACC_LEN);
        create_account(&payer.pubkey(), &acc.pubkey(), rent, ACC_LEN as u64, &self.pid)
    }

    fn init_market(&mut self, ticker: [u8; 8], max: u16, safe: u16) -> Result<(), String> {
        let (a, m) = (self.admin.insecure_clone(), self.market.insecure_clone());
        let data = [&[0u8][..], &ticker, &max.to_le_bytes(), &safe.to_le_bytes()].concat();
        let ixs = vec![
            self.create(&a, &m),
            self.ix(data, vec![AccountMeta::new(m.pubkey(), true), AccountMeta::new_readonly(a.pubkey(), true)]),
        ];
        self.send(ixs, &[&a, &m])
    }

    fn clock_as(&mut self, who: &Keypair, state: u8, safe: u16, close: i64, reopen: i64) -> Result<(), String> {
        let data = [&[1u8, state][..], &safe.to_le_bytes(), &close.to_le_bytes(), &reopen.to_le_bytes()].concat();
        let ix = self.ix(data, vec![AccountMeta::new(self.market.pubkey(), false), AccountMeta::new_readonly(who.pubkey(), true)]);
        self.send(vec![ix], &[who])
    }

    fn clock(&mut self, state: u8, safe: u16, close: i64, reopen: i64) -> Result<(), String> {
        let a = self.admin.insecure_clone();
        self.clock_as(&a, state, safe, close, reopen)
    }

    fn price(&mut self, p: u64) -> Result<(), String> {
        let a = self.admin.insecure_clone();
        let data = [&[2u8][..], &p.to_le_bytes()].concat();
        let ix = self.ix(data, vec![AccountMeta::new(self.market.pubkey(), false), AccountMeta::new_readonly(a.pubkey(), true)]);
        self.send(vec![ix], &[&a])
    }

    fn open(&mut self, pos: &Keypair, coll: u64, debt: u64) -> Result<(), String> {
        let u = self.user.insecure_clone();
        let data = [&[3u8][..], &coll.to_le_bytes(), &debt.to_le_bytes()].concat();
        let ixs = vec![
            self.create(&u, pos),
            self.ix(
                data,
                vec![
                    AccountMeta::new(pos.pubkey(), true),
                    AccountMeta::new_readonly(self.market.pubkey(), false),
                    AccountMeta::new_readonly(u.pubkey(), true),
                ],
            ),
        ];
        self.send(ixs, &[&u, pos])
    }

    fn adjust_as(&mut self, who: &Keypair, pos: &Address, coll: u64, debt: u64) -> Result<(), String> {
        let data = [&[4u8][..], &coll.to_le_bytes(), &debt.to_le_bytes()].concat();
        let ix = self.ix(
            data,
            vec![
                AccountMeta::new(*pos, false),
                AccountMeta::new_readonly(self.market.pubkey(), false),
                AccountMeta::new_readonly(who.pubkey(), true),
            ],
        );
        self.send(vec![ix], &[who])
    }

    fn adjust(&mut self, pos: &Address, coll: u64, debt: u64) -> Result<(), String> {
        let u = self.user.insecure_clone();
        self.adjust_as(&u, pos, coll, debt)
    }

    fn bell(&mut self, pos: &Address) -> Result<(), String> {
        // Anyone can run it: the admin pays here.
        let a = self.admin.insecure_clone();
        let ix = self.ix(vec![5], vec![AccountMeta::new(*pos, false), AccountMeta::new_readonly(self.market.pubkey(), false)]);
        self.send(vec![ix], &[&a])
    }

    fn close(&mut self, acc: &Address, who: &Keypair) -> Result<(), String> {
        let ix = self.ix(vec![6], vec![AccountMeta::new(*acc, false), AccountMeta::new(who.pubkey(), true)]);
        self.send(vec![ix], &[who])
    }

    fn data(&self, a: &Address) -> Vec<u8> {
        self.svm.get_account(a).unwrap().data
    }
}

fn code(res: Result<(), String>, c: u32) {
    let e = res.expect_err("expected failure");
    assert!(e.contains(&format!("Custom({c})")), "expected Custom({c}) in:\n{e}");
}

#[test]
fn market_init_and_clock() {
    let mut e = Env::new();
    let d = e.data(&e.market.pubkey());
    assert_eq!(d[0], TAG_MARKET);
    assert_eq!(d[M_STATE], OPEN);
    assert_eq!(&d[M_TICKER..M_TICKER + 4], b"AAPL");
    assert_eq!(&d[M_AUTH..M_AUTH + 32], e.admin.pubkey().as_ref());
    assert_eq!(u64::from_le_bytes(d[M_PRICE..M_PRICE + 8].try_into().unwrap()), 200 * USD);
    assert_eq!(i64::from_le_bytes(d[M_PRICE_AT..M_PRICE_AT + 8].try_into().unwrap()), T0);

    // Open → closed opens closure #1; closed → closed does not.
    e.clock(CLOSED, 5500, T0 + 30 * H, T0 + 40 * H).unwrap();
    e.clock(CLOSED, 5500, T0 + 30 * H, T0 + 40 * H).unwrap();
    let d = e.data(&e.market.pubkey());
    assert_eq!(u32::from_le_bytes(d[M_CLOSURE..M_CLOSURE + 4].try_into().unwrap()), 1);

    // Only the authority; sane parameters only.
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    code(e.clock_as(&stranger, OPEN, 5500, T0 + 5 * H, 0), UNAUTHORIZED);
    code(e.clock(OPEN, 8000, T0 + 5 * H, 0), BAD_PARAMS); // safe > max
    code(e.clock(OPEN, 5500, T0 + 5 * H, T0 + 4 * H), BAD_PARAMS); // reopen before close
    code(e.clock(9, 5500, T0 + 5 * H, 0), BAD_PARAMS);
    code(e.price(0), BAD_PARAMS);

    // A second init of the same account fails.
    let (a, m) = (e.admin.insecure_clone(), e.market.insecure_clone());
    let data = [&[0u8][..], b"MSFT\0\0\0\0", &7500u16.to_le_bytes(), &5500u16.to_le_bytes()].concat();
    let ix = e.ix(data, vec![AccountMeta::new(m.pubkey(), true), AccountMeta::new_readonly(a.pubkey(), true)]);
    code(e.send(vec![ix], &[&a, &m]), ALREADY_INIT);
}

#[test]
fn borrow_follows_the_clock_and_the_bell() {
    let mut e = Env::new();
    let pos = Keypair::new();
    // 10 shares × $200 = $2,000. 75% → $1,500 before the Bell.
    code(e.open(&pos, 10 * USD, 1_501 * USD), OVER_LIMIT);
    e.open(&pos, 10 * USD, 1_500 * USD).unwrap();
    let p = pos.pubkey();

    // Bell check before the window: refused.
    code(e.bell(&p), NOT_IN_BELL);

    // Inside the Bell window (from close − 2h) the limit is the safe LTV: 55% → $1,100.
    set_time(&mut e.svm, T0 + 3 * H);
    e.price(200 * USD).unwrap();
    code(e.adjust(&p, 10 * USD, 1_600 * USD), OVER_LIMIT);
    // Reducing risk is always allowed, even above the limit.
    e.adjust(&p, 10 * USD, 1_400 * USD).unwrap();
    // Bell check flags the position above the safe LTV...
    e.bell(&p).unwrap();
    assert_eq!(e.data(&p)[P_FLAG], 1);
    // ...a no-op or partial repayment still above it keeps the flag...
    e.adjust(&p, 10 * USD, 1_400 * USD).unwrap();
    assert_eq!(e.data(&p)[P_FLAG], 1);
    e.adjust(&p, 10 * USD, 1_300 * USD).unwrap();
    assert_eq!(e.data(&p)[P_FLAG], 1);
    // ...and it clears once the position is safe.
    e.adjust(&p, 10 * USD, 1_100 * USD).unwrap();
    assert_eq!(e.data(&p)[P_FLAG], 0);
    e.bell(&p).unwrap();
    assert_eq!(e.data(&p)[P_FLAG], 0);

    // Past the posted close with the clock still OPEN: fails closed, no new debt.
    set_time(&mut e.svm, T0 + 5 * H);
    e.price(200 * USD).unwrap();
    code(e.adjust(&p, 10 * USD, 1_101 * USD), MARKET_CLOSED);
    // Repaying still works without a fresh price.
    set_time(&mut e.svm, T0 + 6 * H);
    e.adjust(&p, 10 * USD, 1_000 * USD).unwrap();

    // Next session: open again, but the price is stale until the keeper posts one.
    set_time(&mut e.svm, T0 + 21 * H);
    e.clock(OPEN, 5500, T0 + 27 * H, T0 + 45 * H).unwrap();
    code(e.adjust(&p, 10 * USD, 1_200 * USD), STALE_PRICE);
    e.price(210 * USD).unwrap();
    e.adjust(&p, 10 * USD, 1_200 * USD).unwrap();

    // Halted: no new risk.
    e.clock(HALTED, 5500, T0 + 27 * H, T0 + 45 * H).unwrap();
    code(e.adjust(&p, 10 * USD, 1_201 * USD), MARKET_CLOSED);
    code(e.adjust(&p, 9 * USD, 1_200 * USD), MARKET_CLOSED);
}

#[test]
fn ownership_and_close() {
    let mut e = Env::new();
    let pos = Keypair::new();
    e.open(&pos, 10 * USD, 500 * USD).unwrap();
    let p = pos.pubkey();

    // Someone else cannot adjust or close it.
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    code(e.adjust_as(&stranger, &p, 10 * USD, 0), UNAUTHORIZED);
    code(e.close(&p, &stranger), UNAUTHORIZED);

    // The owner closes it and gets the rent back.
    let u = e.user.insecure_clone();
    let before = e.svm.get_balance(&u.pubkey()).unwrap();
    let rent = e.svm.get_balance(&p).unwrap();
    e.close(&p, &u).unwrap();
    assert!(e.svm.get_account(&p).map_or(true, |a| a.lamports == 0));
    assert_eq!(e.svm.get_balance(&u.pubkey()).unwrap(), before + rent - 5_000);

    // The market's authority closes the market.
    let a = e.admin.insecure_clone();
    let m = e.market.pubkey();
    code(e.close(&m, &u), UNAUTHORIZED);
    e.close(&m, &a).unwrap();
    assert!(e.svm.get_account(&m).map_or(true, |a| a.lamports == 0));
}

#[test]
fn rejects_bad_accounts() {
    let mut e = Env::new();
    let pos = Keypair::new();
    e.open(&pos, 10 * USD, 500 * USD).unwrap();
    let p = pos.pubkey();
    let a = e.admin.insecure_clone();

    // The same account twice (market as position and market).
    let m = e.market.pubkey();
    let ix = e.ix(vec![5], vec![AccountMeta::new(m, false), AccountMeta::new_readonly(m, false)]);
    code(e.send(vec![ix], &[&a]), BAD_ACCOUNT);

    // A position passed where the market goes.
    let ix = e.ix(vec![5], vec![AccountMeta::new(p, false), AccountMeta::new_readonly(p, false)]);
    code(e.send(vec![ix], &[&a]), BAD_ACCOUNT);
    let ix = e.ix(vec![2, 1, 0, 0, 0, 0, 0, 0, 0], vec![AccountMeta::new(p, false), AccountMeta::new_readonly(a.pubkey(), true)]);
    code(e.send(vec![ix], &[&a]), BAD_ACCOUNT);

    // An account not owned by the program.
    let ix = e.ix(vec![5], vec![AccountMeta::new(a.pubkey(), true), AccountMeta::new_readonly(m, false)]);
    code(e.send(vec![ix], &[&a]), BAD_ACCOUNT);

    // Too few accounts; unknown instruction; wrong argument length.
    let ix = e.ix(vec![5], vec![AccountMeta::new(p, false)]);
    code(e.send(vec![ix], &[&a]), BAD_ACCOUNT);
    let ix = e.ix(vec![7], vec![AccountMeta::new(p, false), AccountMeta::new_readonly(m, false)]);
    code(e.send(vec![ix], &[&a]), BAD_INSTRUCTION);
    let ix = e.ix(vec![2, 1], vec![AccountMeta::new(m, false), AccountMeta::new_readonly(a.pubkey(), true)]);
    code(e.send(vec![ix], &[&a]), BAD_INSTRUCTION);
    let ix = e.ix(vec![], vec![]);
    code(e.send(vec![ix], &[&a]), BAD_INSTRUCTION);

    // Opening a position without the position account's signature (someone else's fresh account).
    let victim = Keypair::new();
    let u = e.user.insecure_clone();
    let create = e.create(&u, &victim);
    e.send(vec![create], &[&u, &victim]).unwrap();
    let data = [&[3u8][..], &(10 * USD).to_le_bytes(), &0u64.to_le_bytes()].concat();
    let ix = e.ix(
        data,
        vec![AccountMeta::new(victim.pubkey(), false), AccountMeta::new_readonly(m, false), AccountMeta::new_readonly(u.pubkey(), true)],
    );
    code(e.send(vec![ix], &[&u]), UNAUTHORIZED);
}
