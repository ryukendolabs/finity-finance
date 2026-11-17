//! Finity Lend: collateralised borrowing in a few kilobytes, sized for a mainnet deploy under $5.
//!
//! One markets account holds up to `MAX_MARKETS` markets (ticker, collateral vault, price, max LTV) and the shared
//! loan vault. A user locks collateral and borrows in one instruction (`borrow`), and gets the collateral back by
//! paying the loan off (`repay`). Tokens move through token vaults owned by a program address (seeds
//! `["vault", markets]`), so only this program can pay out of them. Vaults may belong to SPL Token or Token-2022
//! (the loan in USDC, collateral in Token-2022 stock tokens): each transfer goes through the program that owns the
//! account it debits, with `TransferChecked`.
//!
//! Builds (Cargo features):
//! * default, the live mainnet program: init, add_market, post_prices, borrow, repay, close (empty positions).
//! * `full` adds `withdraw` (take collateral out while a loan is open) and `liquidate`. There is no interest.
//! * `teardown` is the shutdown program the live one is upgraded to at the end: only `vault_admin` (move tokens out
//!   of the vaults, close them) and `close` (also the markets account and positions that still hold figures). It is
//!   smaller than the live program, so the upgrade needs no extra rent and the shutdown code costs nothing while live.
//!
//! Trust: the markets authority posts the prices and can move tokens out of the vaults (`vault_admin`, for funding
//! and shutting down). Users trust it the way they trust the price feed. Because of that, the program does not
//! re-check what only the authority can set up (the vault-authority bump, that the vaults belong to it): the
//! operations script verifies those off-chain, and a wrong setup only stops payouts.
//!
//! Accounts this program owns (markets, positions) are created by the client with the System Program in the same
//! transaction as their first instruction and must sign it, so nobody else can initialise them. Closing returns
//! their rent. Duplicate accounts are rejected at the entrypoint, which keeps the unchecked data borrows sound.

#![no_std]
// The teardown build keeps only `close` and `vault_admin`.
#![cfg_attr(feature = "teardown", allow(dead_code))]

use pinocchio::{
    cpi::{invoke_signed_unchecked, CpiAccount, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address,
};

/// Ok, or a custom program error code (shown by explorers as "custom program error: 0x…").
pub type Res<T = ()> = Result<T, u32>;

/// The most accounts any instruction takes.
pub const MAX_ACCOUNTS: usize = 12;

#[cfg(not(feature = "no-entrypoint"))]
mod entry {
    use pinocchio::entrypoint::lazy::{InstructionContext, MaybeAccount};

    pinocchio::no_allocator!();

    /// Program entrypoint (the lazy layout: `instruction_data` arrives in r2, SIMD-0321). Returns 0 on success or a
    /// custom error code, so no `ProgramError` conversion is compiled in.
    #[no_mangle]
    pub unsafe extern "C" fn entrypoint(input: *mut u8, instruction_data: *const u8) -> u64 {
        // SAFETY: passing the program input received from the runtime.
        let mut ctx = unsafe { InstructionContext::new_unchecked(input, instruction_data) };
        let program_id = *ctx.program_id();
        let data = ctx.instruction_data();
        // SAFETY: the instruction data lives in the input buffer for the whole call; reading accounts below only
        // moves the context's cursor and never touches it.
        let data = unsafe { core::slice::from_raw_parts(data.as_ptr(), data.len()) };
        let mut accounts = [None; crate::MAX_ACCOUNTS];
        let n = (ctx.remaining() as usize).min(crate::MAX_ACCOUNTS);
        for slot in accounts.iter_mut().take(n) {
            // SAFETY: at most `remaining` accounts are read (`next_account_unchecked` does not decrement it).
            match unsafe { ctx.next_account_unchecked() } {
                MaybeAccount::Account(a) => *slot = Some(a),
                // A duplicate would alias the unchecked borrows: refuse it.
                MaybeAccount::Duplicated(_) => return crate::BAD_ACCOUNT as u64,
            }
        }
        match crate::process(&program_id, &accounts, data) {
            Ok(()) => 0,
            Err(code) => code as u64,
        }
    }

    /// Aborts without formatting a message: keeps core::fmt out of the binary. No path is expected to panic.
    #[cfg(target_os = "solana")]
    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
        unsafe { pinocchio::syscalls::abort() }
    }
}

#[cfg(not(target_os = "solana"))]
extern crate std;

// ---- Layout -------------------------------------------------------------------------------------------------------

pub const TAG_MARKETS: u8 = 1;
pub const TAG_POSITION: u8 = 2;

pub const MAX_MARKETS: usize = 8;

/// Markets account: tag u8 | bump u8 | count u8 | pad 5 | authority 32 | loan_vault 32 | price_at i64, then
/// `MAX_MARKETS` markets of `MKT_LEN` bytes from `H_LEN`.
pub const H_BUMP: usize = 1;
pub const H_COUNT: usize = 2;
pub const H_AUTH: usize = 8;
pub const H_LOAN_VAULT: usize = 40;
pub const H_PRICE_AT: usize = 72;
pub const H_LEN: usize = 80;
/// One market: ticker 8 | collateral vault 32 | price u64 | max_ltv_bps u16 | pad 6.
pub const MKT_TICKER: usize = 0;
pub const MKT_VAULT: usize = 8;
pub const MKT_PRICE: usize = 40;
pub const MKT_MAX: usize = 48;
pub const MKT_LEN: usize = 56;
pub const MARKETS_LEN: usize = H_LEN + MAX_MARKETS * MKT_LEN;

/// Position: tag u8 | market index u8 | pad 6 | owner 32 | markets 32 | collateral u64 | debt u64.
/// The owner sits at the same offset as the markets authority, which `close` relies on.
pub const P_IDX: usize = 1;
pub const P_OWNER: usize = 8;
pub const P_MARKETS: usize = 40;
pub const P_COLL: usize = 72;
pub const P_DEBT: usize = 80;
pub const POSITION_LEN: usize = 88;

/// A price older than this supports no new borrowing. The keeper posts every 15 minutes while markets are open.
pub const MAX_PRICE_AGE_SECS: i64 = 20 * 60;
/// Prices and loans use 6 decimals (USD). A market's price is per 10⁶ base units of its collateral (a whole token at
/// 6 decimals; the keeper scales it for other decimals, e.g. ÷100 for 8).
pub const ONE: u128 = 1_000_000;
pub const BPS: u128 = 10_000;

pub const VAULT_SEED: &[u8] = b"vault";

/// SPL Token (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA).
pub const TOKEN_PROGRAM: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145,
    58, 140, 245, 133, 126, 255, 0, 169,
]);
/// Token-2022 (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb).
pub const TOKEN_2022: Address = Address::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39,
    254, 189, 249, 40, 216, 161, 139, 252,
]);
const TOKEN_TRANSFER_CHECKED: u8 = 12;
/// Decimals in a mint account (the same offset for both token programs).
const MINT_DECIMALS: usize = 44;
#[cfg(feature = "teardown")]
const TOKEN_CLOSE: u8 = 9;

// ---- Instructions ------------------------------------------------------------------------------------------------

pub const IX_INIT: u8 = 0;
pub const IX_ADD_MARKET: u8 = 1;
pub const IX_POST_PRICES: u8 = 2;
pub const IX_BORROW: u8 = 3;
pub const IX_REPAY: u8 = 4;
pub const IX_CLOSE: u8 = 5;
pub const IX_VAULT_ADMIN: u8 = 6;
pub const IX_WITHDRAW: u8 = 7;
pub const IX_LIQUIDATE: u8 = 8;

// ---- Errors (custom program error codes; 0 is success) ------------------------------------------------------------

/// Wrong owner, length, tag, vault or count, or a duplicate account.
pub const BAD_ACCOUNT: u32 = 1;
/// A required signature is missing, or the signer is not the markets authority / position owner.
pub const UNAUTHORIZED: u32 = 2;
/// Unknown instruction (or one left out of this build) or wrong argument length.
pub const BAD_INSTRUCTION: u32 = 3;
/// Out-of-range parameters (LTV, market index, amounts above what is owed or held, a position not yet empty).
pub const BAD_PARAMS: u32 = 4;
pub const STALE_PRICE: u32 = 5;
pub const OVER_LIMIT: u32 = 7;
/// The account is already initialised.
pub const ALREADY_INIT: u32 = 9;
/// The cluster clock could not be read.
pub const NO_CLOCK: u32 = 10;
/// `liquidate` on a position within its LTV.
pub const NOT_LIQUIDATABLE: u32 = 11;

// ---- Byte helpers -------------------------------------------------------------------------------------------------
// Offsets into account data are constants or bounded by a checked market index; argument lengths are verified once
// in `process`. Debug builds assert.

#[inline]
fn rd<const N: usize>(d: &[u8], o: usize) -> [u8; N] {
    debug_assert!(o + N <= d.len());
    unsafe { (d.as_ptr().add(o) as *const [u8; N]).read_unaligned() }
}
#[inline]
fn rd_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(rd(d, o))
}
#[inline]
fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(rd(d, o))
}
#[inline]
fn wr<const N: usize>(d: &mut [u8], o: usize, b: [u8; N]) {
    debug_assert!(o + N <= d.len());
    unsafe { (d.as_mut_ptr().add(o) as *mut [u8; N]).write_unaligned(b) }
}
#[inline]
fn wr_u64(d: &mut [u8], o: usize, v: u64) {
    wr(d, o, v.to_le_bytes())
}
/// The 32 bytes at `o` equal `k`.
#[inline(never)]
fn eq32(d: &[u8], o: usize, k: &Address) -> bool {
    rd::<32>(d, o) == *k.as_array()
}

fn now() -> Res<i64> {
    Clock::get().map(|c| c.unix_timestamp).map_err(|_| NO_CLOCK)
}

// ---- Pure rules (tested on the host) ------------------------------------------------------------------------------

/// debt ≤ ltv × collateral × price, all 6-decimal fixed point, compared as debt·10⁴·10⁶ ≤ coll·price·ltv (no
/// division: u128 division is a large software routine on SBF). The left side is below 2⁹⁸ (debt < 2⁶⁴,
/// 10¹⁰ < 2³⁴). If coll·price ≥ 2⁹⁸ and ltv ≥ 1 the right side is larger; otherwise coll·price·ltv < 2¹¹⁴ fits.
pub fn within(debt: u64, collateral: u64, price: u64, ltv_bps: u16) -> bool {
    let lhs = debt as u128 * (BPS * ONE);
    let value = collateral as u128 * price as u128;
    if ltv_bps != 0 && value >> 98 != 0 {
        return true;
    }
    lhs <= value * ltv_bps as u128
}

// ---- Accounts -----------------------------------------------------------------------------------------------------

/// The data of an account owned by this program, of length `N`, with the expected tag (0 = uninitialised).
#[inline(never)]
fn data<'a, const N: usize>(program_id: &Address, a: &'a AccountView, tag: u8) -> Res<&'a mut [u8; N]> {
    if !a.owned_by(program_id) || a.data_len() != N {
        return Err(BAD_ACCOUNT);
    }
    // SAFETY: the length is N; duplicates were rejected at the entrypoint and each account's data is taken once per
    // instruction, so no other live reference reaches it.
    let d = unsafe { &mut *(a.data_ptr() as *mut [u8; N]) };
    if d[0] != tag {
        return Err(if tag == 0 { ALREADY_INIT } else { BAD_ACCOUNT });
    }
    Ok(d)
}

fn signer(a: &AccountView) -> Res {
    if a.is_signer() {
        Ok(())
    } else {
        Err(UNAUTHORIZED)
    }
}

#[inline(always)]
fn get(accounts: &[Option<AccountView>; MAX_ACCOUNTS], i: usize) -> Res<&AccountView> {
    debug_assert!(i < MAX_ACCOUNTS);
    // SAFETY: every call site passes a constant below MAX_ACCOUNTS.
    unsafe { accounts.get_unchecked(i) }.as_ref().ok_or(BAD_ACCOUNT)
}

/// The markets account, after checking that `auth` signed and is its authority.
fn markets_admin<'a>(program_id: &Address, m: &'a AccountView, auth: &AccountView) -> Res<&'a mut [u8; MARKETS_LEN]> {
    signer(auth)?;
    let d = data::<MARKETS_LEN>(program_id, m, TAG_MARKETS)?;
    if !eq32(d, H_AUTH, auth.address()) {
        return Err(UNAUTHORIZED);
    }
    Ok(d)
}

#[inline(never)]
fn init_cpi<'a>(a: &'a AccountView, slot: &mut core::mem::MaybeUninit<CpiAccount<'a>>) {
    CpiAccount::init_from_account_view(a, slot);
}

/// The token programs passed to the instruction (the same one twice when only one is passed) and the vault
/// authority's seeds (markets address, bump).
#[derive(Clone, Copy)]
struct Vaults<'a> {
    tokens: [&'a AccountView; 2],
    markets: &'a Address,
    bump: u8,
}

/// A token instruction on `accs` (writable unless `ro`; the last one signs), sent to the token program that owns
/// `accs[0]` (the account debited or closed), which must be SPL Token or Token-2022 and among `v.tokens`. Always signed
/// with the vault authority's seeds: harmless when the authority is the user, who signed the transaction.
#[inline(never)]
fn token_cpi<const N: usize>(v: Vaults, accs: [&AccountView; N], ro: [bool; N], data: &[u8]) -> Res {
    let prog = if accs[0].owned_by(&TOKEN_PROGRAM) {
        &TOKEN_PROGRAM
    } else if accs[0].owned_by(&TOKEN_2022) {
        &TOKEN_2022
    } else {
        return Err(BAD_ACCOUNT);
    };
    if v.tokens[0].address() != prog && v.tokens[1].address() != prog {
        return Err(BAD_ACCOUNT);
    }
    let metas: [InstructionAccount; N] = core::array::from_fn(|i| {
        let a = accs[i].address();
        if i == N - 1 {
            InstructionAccount::readonly_signer(a)
        } else if ro[i] {
            InstructionAccount::readonly(a)
        } else {
            InstructionAccount::writable(a)
        }
    });
    let ix = InstructionView { program_id: prog, data, accounts: &metas };
    let mut cpi = [const { core::mem::MaybeUninit::<CpiAccount>::uninit() }; N];
    let mut i = 0;
    while i < N {
        // SAFETY: i < N.
        init_cpi(unsafe { accs.get_unchecked(i) }, unsafe { cpi.get_unchecked_mut(i) });
        i += 1;
    }
    // SAFETY: all N slots were initialised above; MaybeUninit<T> has T's layout.
    let cpi: [CpiAccount; N] = unsafe { core::mem::transmute_copy(&cpi) };
    let bump = [v.bump];
    let seeds = [Seed::from(VAULT_SEED), Seed::from(v.markets.as_array()), Seed::from(&bump)];
    // SAFETY: none of the token accounts' data is borrowed by this program while the token program runs.
    unsafe { invoke_signed_unchecked(&ix, &cpi, &[Signer::from(&seeds)]) };
    Ok(())
}

/// `TransferChecked` of `amount` from `from` to `to` (both of `mint`), authorised by `auth`.
fn transfer(v: Vaults, from: &AccountView, mint: &AccountView, to: &AccountView, auth: &AccountView, amount: u64) -> Res {
    if amount == 0 {
        return Ok(());
    }
    if mint.data_len() <= MINT_DECIMALS {
        return Err(BAD_ACCOUNT);
    }
    // SAFETY: the length is checked; the token program checks the mint is the accounts' (and owned by it).
    let decimals = unsafe { *mint.data_ptr().add(MINT_DECIMALS) };
    let mut data = [TOKEN_TRANSFER_CHECKED, 0, 0, 0, 0, 0, 0, 0, 0, decimals];
    wr_u64(&mut data, 1, amount);
    token_cpi(v, [from, mint, to, auth], [false, true, false, true], &data)
}

// ---- Dispatch -----------------------------------------------------------------------------------------------------

/// Instructions (first byte), accounts and arguments (little-endian):
///
/// | # | Name | Accounts | Arguments |
/// |---|---|---|---|
/// | 0 | init | markets (w, s), authority (s), loan vault | vault-authority bump u8 |
/// | 1 | add_market | markets (w), authority (s), collateral vault | ticker [u8; 8], max_ltv_bps u16 |
/// | 2 | post_prices | markets (w), authority (s) | price u64 × market count |
/// | 3 | borrow | P | market index u8 (used when opening), collateral in u64, loan out u64 |
/// | 4 | repay | P | amount u64; paying the loan off returns all the collateral |
/// | 5 | close | markets or empty position (w), its authority or owner (s, w) | — |
/// | 6 | vault_admin (teardown) | markets, authority (s, w), vault (w), destination (w; unused by op 1), vault authority, token program, vault's mint | op u8 (0 transfer, 1 close to the authority), amount u64 |
/// | 7 | withdraw (`full`) | P | collateral out u64 |
/// | 8 | liquidate (`full`) | P, with the liquidator as the user | — |
///
/// P = position (w; s when opening), markets, user (s), user collateral token account (w), collateral vault (w),
/// user loan token account (w), loan vault (w), vault authority, collateral mint, loan mint, token program, and the
/// other token program when collateral and loan use different ones.
pub fn process(program_id: &Address, accounts: &[Option<AccountView>; MAX_ACCOUNTS], data: &[u8]) -> Res {
    let (&ix, args) = data.split_first().ok_or(BAD_INSTRUCTION)?;
    let want = match ix {
        #[cfg(not(feature = "teardown"))]
        IX_INIT => 1,
        #[cfg(not(feature = "teardown"))]
        IX_ADD_MARKET => 10,
        #[cfg(not(feature = "teardown"))]
        IX_POST_PRICES => args.len(), // checked against the market count
        #[cfg(not(feature = "teardown"))]
        IX_BORROW => 17,
        #[cfg(not(feature = "teardown"))]
        IX_REPAY => 8,
        IX_CLOSE => 0,
        #[cfg(feature = "teardown")]
        IX_VAULT_ADMIN => 9,
        #[cfg(all(feature = "full", not(feature = "teardown")))]
        IX_WITHDRAW => 8,
        #[cfg(all(feature = "full", not(feature = "teardown")))]
        IX_LIQUIDATE => 0,
        _ => return Err(BAD_INSTRUCTION),
    };
    if args.len() != want {
        return Err(BAD_INSTRUCTION);
    }
    let (first, second) = (get(accounts, 0)?, get(accounts, 1)?);
    match ix {
        IX_CLOSE => close(program_id, first, second),
        #[cfg(feature = "teardown")]
        _ => vault_admin(program_id, accounts, args),
        #[cfg(not(feature = "teardown"))]
        IX_INIT => init(program_id, first, second, get(accounts, 2)?, rd::<1>(args, 0)[0]),
        #[cfg(not(feature = "teardown"))]
        IX_ADD_MARKET => add_market(program_id, first, second, get(accounts, 2)?, args),
        #[cfg(not(feature = "teardown"))]
        IX_POST_PRICES => post_prices(program_id, first, second, args),
        #[cfg(not(feature = "teardown"))]
        _ => position_op(program_id, accounts, ix, args),
    }
}

/// 0. init. The markets account must sign, so only its creator can initialise it. `bump` is the vault authority's
/// (seeds `["vault", markets]`); the loan vault must be a token account it owns.
fn init(program_id: &Address, m: &AccountView, auth: &AccountView, loan_vault: &AccountView, bump: u8) -> Res {
    signer(m)?;
    signer(auth)?;
    let d = data::<MARKETS_LEN>(program_id, m, 0)?;
    d[0] = TAG_MARKETS;
    d[H_BUMP] = bump;
    wr(d, H_AUTH, *auth.address().as_array());
    wr(d, H_LOAN_VAULT, *loan_vault.address().as_array());
    Ok(())
}

/// 1. add_market, by the authority; `vault` must be a token account the vault authority owns. Markets start with no price, so nobody can borrow until the keeper posts one.
fn add_market(program_id: &Address, m: &AccountView, auth: &AccountView, vault: &AccountView, a: &[u8]) -> Res {
    let d = markets_admin(program_id, m, auth)?;
    let count = d[H_COUNT] as usize;
    let max = rd_u16(a, 8);
    if count >= MAX_MARKETS || max == 0 || max as u128 >= BPS {
        return Err(BAD_PARAMS);
    }
    let base = H_LEN + count * MKT_LEN;
    wr(d, base + MKT_TICKER, rd::<8>(a, 0));
    wr(d, base + MKT_VAULT, *vault.address().as_array());
    wr(d, base + MKT_MAX, max.to_le_bytes());
    d[H_COUNT] = count as u8 + 1;
    Ok(())
}

/// 2. post_prices, by the authority: one price per market, in order, stamped with the cluster clock. A zero price
/// pauses borrowing in that market.
fn post_prices(program_id: &Address, m: &AccountView, auth: &AccountView, a: &[u8]) -> Res {
    let d = markets_admin(program_id, m, auth)?;
    let count = d[H_COUNT] as usize;
    if a.len() != count * 8 {
        return Err(BAD_INSTRUCTION);
    }
    for i in 0..count {
        wr_u64(d, H_LEN + i * MKT_LEN + MKT_PRICE, rd_u64(a, i * 8));
    }
    wr(d, H_PRICE_AT, now()?.to_le_bytes());
    Ok(())
}

/// The market's price, if it is fresh.
fn fresh_price(md: &[u8], base: usize) -> Res<u64> {
    let at = i64::from_le_bytes(rd(md, H_PRICE_AT));
    if now()?.saturating_sub(at) > MAX_PRICE_AGE_SECS {
        return Err(STALE_PRICE);
    }
    Ok(rd_u64(md, base + MKT_PRICE))
}

/// 3. borrow, 4. repay, 7. withdraw, 8. liquidate.
///
/// Borrowing (or withdrawing with a loan open) needs a fresh price and the position within the market's max LTV
/// afterwards. Repaying never needs a price; paying the loan off returns all the collateral.
fn position_op(program_id: &Address, accounts: &[Option<AccountView>; MAX_ACCOUNTS], ix: u8, a: &[u8]) -> Res {
    let p = get(accounts, 0)?;
    let m = get(accounts, 1)?;
    let user = get(accounts, 2)?;
    let user_coll = get(accounts, 3)?;
    let coll_vault = get(accounts, 4)?;
    let user_loan = get(accounts, 5)?;
    let loan_vault = get(accounts, 6)?;
    let vault_auth = get(accounts, 7)?;
    let (coll_mint, loan_mint) = (get(accounts, 8)?, get(accounts, 9)?);
    let token = get(accounts, 10)?;
    let tokens = [token, get(accounts, 11).unwrap_or(token)];
    signer(user)?;
    let md = data::<MARKETS_LEN>(program_id, m, TAG_MARKETS)?;

    // An uninitialised account is opened by `borrow`; everything else needs an existing position in these markets.
    if !p.owned_by(program_id) || p.data_len() != POSITION_LEN {
        return Err(BAD_ACCOUNT);
    }
    // SAFETY: as in `data`: the length is checked and this is the only reference to the position's data.
    let d = unsafe { &mut *(p.data_ptr() as *mut [u8; POSITION_LEN]) };
    if d[0] == 0 && ix == IX_BORROW {
        signer(p)?;
        let [idx] = rd::<1>(a, 0);
        if idx >= md[H_COUNT] {
            return Err(BAD_PARAMS);
        }
        d[0] = TAG_POSITION;
        d[P_IDX] = idx;
        wr(d, P_OWNER, *user.address().as_array());
        wr(d, P_MARKETS, *m.address().as_array());
    } else if d[0] != TAG_POSITION || !eq32(d, P_MARKETS, m.address()) {
        return Err(BAD_ACCOUNT);
    } else if ix != IX_LIQUIDATE && !eq32(d, P_OWNER, user.address()) {
        return Err(UNAUTHORIZED);
    }

    let base = H_LEN + d[P_IDX] as usize * MKT_LEN;
    if !eq32(md, base + MKT_VAULT, coll_vault.address()) || !eq32(md, H_LOAN_VAULT, loan_vault.address()) {
        return Err(BAD_ACCOUNT);
    }
    let max = rd_u16(md, base + MKT_MAX);
    let v = Vaults { tokens, markets: m.address(), bump: md[H_BUMP] };
    let (coll, debt) = (rd_u64(d, P_COLL), rd_u64(d, P_DEBT));

    // (collateral in, collateral out, loan in, loan out) and whether the result must pass the LTV check.
    let (coll_in, coll_out, loan_in, loan_out, check) = match ix {
        IX_BORROW => {
            let (add, out) = (rd_u64(a, 1), rd_u64(a, 9));
            (add, 0, 0, out, out > 0)
        }
        IX_REPAY => {
            let amount = rd_u64(a, 0);
            if amount > debt {
                return Err(BAD_PARAMS);
            }
            (0, if amount == debt { coll } else { 0 }, amount, 0, false)
        }
        #[cfg(feature = "full")]
        IX_WITHDRAW => {
            let out = rd_u64(a, 0);
            if out > coll {
                return Err(BAD_PARAMS);
            }
            (0, out, 0, 0, debt > 0)
        }
        #[cfg(feature = "full")]
        IX_LIQUIDATE => {
            if debt == 0 || within(debt, coll, fresh_price(md, base)?, max) {
                return Err(NOT_LIQUIDATABLE);
            }
            (0, coll, debt, 0, false)
        }
        _ => return Err(BAD_INSTRUCTION),
    };
    let new_coll = coll.checked_add(coll_in).ok_or(BAD_PARAMS)? - coll_out;
    let new_debt = debt.checked_add(loan_out).ok_or(BAD_PARAMS)? - loan_in;
    if check && !within(new_debt, new_coll, fresh_price(md, base)?, max) {
        return Err(OVER_LIMIT);
    }
    wr_u64(d, P_COLL, new_coll);
    wr_u64(d, P_DEBT, new_debt);

    // At most one transfer in (signed by the user) and one out (signed by the vault authority): borrow takes
    // collateral in and pays the loan out; the others take the loan in and pay collateral out.
    let (in_pair, in_amount, out_pair, out_amount) = if ix == IX_BORROW {
        ((user_coll, coll_mint, coll_vault), coll_in, (loan_vault, loan_mint, user_loan), loan_out)
    } else {
        ((user_loan, loan_mint, loan_vault), loan_in, (coll_vault, coll_mint, user_coll), coll_out)
    };
    transfer(v, in_pair.0, in_pair.1, in_pair.2, user, in_amount)?;
    transfer(v, out_pair.0, out_pair.1, out_pair.2, vault_auth, out_amount)
}

/// 5. close. Closes an empty position (by its owner) and returns the rent. The teardown build also closes the markets
/// account (by its authority) and positions that still hold figures. Both keep the authority/owner at offset 8.
fn close(program_id: &Address, a: &AccountView, to: &AccountView) -> Res {
    signer(to)?;
    if !a.owned_by(program_id) {
        return Err(BAD_ACCOUNT);
    }
    // SAFETY: the length is checked before any field is read.
    let d = unsafe { core::slice::from_raw_parts(a.data_ptr(), a.data_len()) };
    if d.len() < H_AUTH + 32 {
        return Err(BAD_ACCOUNT);
    }
    // The signer first, so a stranger learns nothing about the account.
    if !eq32(d, H_AUTH, to.address()) {
        return Err(UNAUTHORIZED);
    }
    match (d.first(), d.len()) {
        #[cfg(feature = "teardown")]
        (Some(&TAG_MARKETS), MARKETS_LEN) => {}
        // At teardown the authority has already paid the collateral back from the vaults.
        (Some(&TAG_POSITION), POSITION_LEN) => {
            if !cfg!(feature = "teardown") && rd_u64(d, P_COLL) | rd_u64(d, P_DEBT) != 0 {
                return Err(BAD_PARAMS);
            }
        }
        _ => return Err(BAD_ACCOUNT),
    }
    let (mut a, mut to) = (*a, *to);
    to.set_lamports(to.lamports() + a.lamports());
    a.set_lamports(0);
    // SAFETY: no reference to `a`'s data is alive past this point.
    unsafe { a.close_unchecked() };
    Ok(())
}

/// 6. vault_admin (teardown build only), by the authority: move tokens out of a vault (op 0: funding changes and shutdown) or close an
/// empty vault and return its rent to the authority (op 1). Only token accounts owned by this markets' vault authority can be
/// touched, since that is the only signature the program adds.
#[cfg(feature = "teardown")]
fn vault_admin(program_id: &Address, accounts: &[Option<AccountView>; MAX_ACCOUNTS], a: &[u8]) -> Res {
    let m = get(accounts, 0)?;
    let auth = get(accounts, 1)?;
    let vault = get(accounts, 2)?;
    let dest = get(accounts, 3)?;
    let vault_auth = get(accounts, 4)?;
    let d = markets_admin(program_id, m, auth)?;
    let token = get(accounts, 5)?;
    let v = Vaults { tokens: [token, token], markets: m.address(), bump: d[H_BUMP] };
    match rd::<1>(a, 0)[0] {
        0 => transfer(v, vault, get(accounts, 6)?, dest, vault_auth, rd_u64(a, 1)),
        // The rent goes to the authority (writable); `dest` is not used.
        1 => token_cpi(v, [vault, auth, vault_auth], [false, false, true], &[TOKEN_CLOSE]),
        _ => Err(BAD_PARAMS),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ltv_math() {
        // 10 shares at $200 = $2,000; 50% → $1,000.
        let (coll, price) = (10 * ONE as u64, 200 * ONE as u64);
        assert!(within(1_000 * ONE as u64, coll, price, 5000));
        assert!(!within(1_000 * ONE as u64 + 1, coll, price, 5000));
        assert!(within(0, 0, price, 0));
        assert!(!within(1, coll, 0, 5000));
        assert!(within(u64::MAX, u64::MAX, u64::MAX, 9999));
        assert!(!within(u64::MAX, 1, 1, 9999));
    }

    #[test]
    fn layout_fits() {
        assert_eq!(MARKETS_LEN, 528);
        assert!(H_PRICE_AT + 8 <= H_LEN);
        assert!(MKT_MAX + 2 <= MKT_LEN);
        assert_eq!(P_OWNER, H_AUTH);
    }
}
