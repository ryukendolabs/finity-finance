//! Finity V2: the Asset Clock and the Bell Check in a few kilobytes, sized for a mainnet deploy under $5.
//!
//! The full protocol (lending, Gap Cover, underwriter pools, batch auctions) runs on devnet in `programs/finity`.
//! This program keeps the two ideas that make Finity different and puts them on mainnet:
//!
//! * **Asset Clock**: every market carries its venue state (open, extended, closed, halted, reopen), its next close
//!   and reopen, and its last price. Inputs fail closed: a clock that has not been advanced past a close, or a stale
//!   price, is treated as closed.
//! * **Bell Check**: from two hours before the close, a position must be at the closure-safe LTV (calibrated by the
//!   full risk engine and posted with the clock). A permissionless `bell_check` flags any position that is not.
//!
//! Positions are records (collateral and debt figures), not token custody: no funds move through this program.
//!
//! Accounts are created by the client with the System Program (owner = this program) in the same transaction as
//! their init instruction, and must sign it, so nobody else can initialise them. Closing returns their rent.
//!
//! Size matters here (rent is ~0.007 SOL per KB of program), so the code avoids bounds checks, u128 division and
//! the panic formatter: account data is handled as fixed-size arrays and argument lengths are checked once, up
//! front. Duplicate accounts are rejected at the entrypoint, which is what makes the unchecked data borrows sound.

#![no_std]

use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address,
};

/// Ok, or a custom program error code (shown by explorers as "custom program error: 0x…").
pub type Res<T = ()> = Result<T, u32>;

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
        let mut accounts = [None; 3];
        let n = (ctx.remaining() as usize).min(3);
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

/// Markets and positions have the same length; the first byte (tag) tells them apart. 0 = not yet initialised.
pub const ACC_LEN: usize = 88;
type Data = [u8; ACC_LEN];

pub const TAG_MARKET: u8 = 1;
pub const TAG_POSITION: u8 = 2;

/// Market: tag u8 | state u8 | max_ltv_bps u16 | safe_ltv_bps u16 | pad 2 | authority 32 | ticker 8 | price u64 |
/// price_at i64 | next_close i64 | next_reopen i64 | closure_id u32 | pad 4
pub const M_STATE: usize = 1;
pub const M_MAX: usize = 2;
pub const M_SAFE: usize = 4;
pub const M_AUTH: usize = 8;
pub const M_TICKER: usize = 40;
pub const M_PRICE: usize = 48;
pub const M_PRICE_AT: usize = 56;
pub const M_CLOSE: usize = 64;
pub const M_REOPEN: usize = 72;
pub const M_CLOSURE: usize = 80;

/// Position: tag u8 | flagged u8 | pad 6 | owner 32 | market 32 | collateral u64 | debt u64
pub const P_FLAG: usize = 1;
pub const P_OWNER: usize = 8;
pub const P_MARKET: usize = 40;
pub const P_COLL: usize = 72;
pub const P_DEBT: usize = 80;

pub const OPEN: u8 = 0;
pub const EXTENDED: u8 = 1;
pub const CLOSED: u8 = 2;
pub const HALTED: u8 = 3;
pub const REOPEN: u8 = 4;

/// The Bell window opens two hours before the close.
pub const BELL_WINDOW_SECS: i64 = 2 * 3600;
/// A price older than this does not support new risk.
pub const MAX_PRICE_AGE_SECS: i64 = 300;
/// Prices and debt use 6 decimals (USD); collateral is in base units with 6 decimals.
pub const ONE: u128 = 1_000_000;
pub const BPS: u128 = 10_000;

// ---- Errors (custom program error codes; 0 is success) ------------------------------------------------------------

/// Wrong owner, length, tag or count, or a duplicate account.
pub const BAD_ACCOUNT: u32 = 1;
/// A required signature is missing, or the signer is not the market authority / position owner.
pub const UNAUTHORIZED: u32 = 2;
/// Unknown instruction or wrong argument length.
pub const BAD_INSTRUCTION: u32 = 3;
/// Out-of-range parameters (LTVs, times, zero price).
pub const BAD_PARAMS: u32 = 4;
pub const STALE_PRICE: u32 = 5;
/// The market accepts no new risk (closed, halted, reopening, or past its posted close).
pub const MARKET_CLOSED: u32 = 6;
pub const OVER_LIMIT: u32 = 7;
/// `bell_check` outside the Bell window.
pub const NOT_IN_BELL: u32 = 8;
/// The account is already initialised.
pub const ALREADY_INIT: u32 = 9;
/// The cluster clock could not be read.
pub const NO_CLOCK: u32 = 10;

// ---- Byte helpers -------------------------------------------------------------------------------------------------
// On account data (`Data`) the offsets are constants, checked at compile time. On instruction arguments the
// helpers are unchecked: `process` has verified each instruction's exact argument length. Debug builds assert.

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
fn rd_i64(d: &[u8], o: usize) -> i64 {
    rd_u64(d, o) as i64
}
#[inline]
fn wr<const N: usize>(d: &mut Data, o: usize, b: [u8; N]) {
    debug_assert!(o + N <= ACC_LEN);
    // SAFETY: every call site passes a constant field offset whose field fits in ACC_LEN.
    unsafe { (d.as_mut_ptr().add(o) as *mut [u8; N]).write_unaligned(b) }
}
/// The 32 bytes at `o` equal `k`.
#[inline(never)]
fn eq32(d: &Data, o: usize, k: &Address) -> bool {
    rd::<32>(d, o) == *k.as_array()
}

fn now() -> Res<i64> {
    Clock::get().map(|c| c.unix_timestamp).map_err(|_| NO_CLOCK)
}

// ---- Pure rules (tested on the host) ------------------------------------------------------------------------------

/// The state the clock is allowed to report at `now`. Fails closed: a market still marked OPEN or EXTENDED after
/// its posted close has passed (or with no close posted) is CLOSED until the keeper advances it.
pub fn effective_state(state: u8, next_close: i64, now: i64) -> u8 {
    if (state == OPEN || state == EXTENDED) && (next_close == 0 || now >= next_close) {
        CLOSED
    } else {
        state
    }
}

/// True once the Bell window before the next close has opened.
pub fn in_bell(next_close: i64, now: i64) -> bool {
    next_close > 0 && now >= next_close - BELL_WINDOW_SECS
}

/// The LTV limit (bps) a position must meet now, or `None` when the market accepts no new risk.
/// OPEN before the Bell: max LTV. OPEN inside the Bell, or EXTENDED: the closure-safe LTV. Otherwise none.
pub fn limit_bps(state: u8, max_bps: u16, safe_bps: u16, next_close: i64, now: i64) -> Option<u16> {
    match effective_state(state, next_close, now) {
        OPEN if !in_bell(next_close, now) => Some(max_bps),
        OPEN | EXTENDED => Some(safe_bps),
        _ => None,
    }
}

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

/// The data of an account owned by this program, of length `ACC_LEN`, with the expected tag (0 = uninitialised).
#[inline(never)]
fn data<'a>(program_id: &Address, a: &'a AccountView, tag: u8) -> Res<&'a mut Data> {
    if !a.owned_by(program_id) || a.data_len() != ACC_LEN {
        return Err(BAD_ACCOUNT);
    }
    // SAFETY: the length is ACC_LEN; duplicates were rejected at the entrypoint and each account's data is taken
    // once per instruction, so no other live reference reaches it.
    let d = unsafe { &mut *(a.data_ptr() as *mut Data) };
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

// ---- Dispatch -----------------------------------------------------------------------------------------------------

/// Instructions (first byte), accounts and arguments (little-endian):
///
/// | # | Name | Accounts | Arguments |
/// |---|---|---|---|
/// | 0 | init_market | market (w, s), authority (s) | ticker [u8; 8], max_ltv_bps u16, safe_ltv_bps u16 |
/// | 1 | update_clock | market (w), authority (s) | state u8, safe_ltv_bps u16, next_close i64, next_reopen i64 |
/// | 2 | post_price | market (w), authority (s) | price u64 |
/// | 3 | open_position | position (w, s), market, owner (s) | collateral u64, debt u64 |
/// | 4 | adjust_position | position (w), market, owner (s) | collateral u64, debt u64 |
/// | 5 | bell_check | position (w), market | — |
/// | 6 | close | market or position (w), its authority or owner (s, w) | — |
pub fn process(program_id: &Address, accounts: &[Option<AccountView>; 3], data: &[u8]) -> Res {
    let (&ix, args) = data.split_first().ok_or(BAD_INSTRUCTION)?;
    let want = match ix {
        0 => 12,
        1 => 19,
        2 => 8,
        3 | 4 => 16,
        5 | 6 => 0,
        _ => return Err(BAD_INSTRUCTION),
    };
    if args.len() != want {
        return Err(BAD_INSTRUCTION);
    }
    let (Some(first), Some(second)) = (&accounts[0], &accounts[1]) else {
        return Err(BAD_ACCOUNT);
    };
    match ix {
        0 => init_market(program_id, first, second, args),
        1 | 2 => market_update(program_id, first, second, ix, args),
        3 | 4 => {
            let Some(owner) = &accounts[2] else {
                return Err(BAD_ACCOUNT);
            };
            set_position(program_id, first, second, owner, ix == 3, args)
        }
        5 => bell_check(program_id, first, second),
        _ => close(program_id, first, second),
    }
}

/// 0. init_market. The market account must sign, so only its creator can initialise it.
fn init_market(program_id: &Address, m: &AccountView, auth: &AccountView, a: &[u8]) -> Res {
    signer(m)?;
    signer(auth)?;
    let (max, safe) = (rd_u16(a, 8), rd_u16(a, 10));
    if max == 0 || max as u128 >= BPS || safe > max {
        return Err(BAD_PARAMS);
    }
    let d = data(program_id, m, 0)?;
    d[0] = TAG_MARKET;
    d[M_STATE] = CLOSED;
    wr(d, M_MAX, max.to_le_bytes());
    wr(d, M_SAFE, safe.to_le_bytes());
    wr(d, M_AUTH, *auth.address().as_array());
    wr(d, M_TICKER, rd::<8>(a, 0));
    Ok(())
}

/// 1. update_clock / 2. post_price, both by the market authority.
///
/// update_clock: a move from OPEN/EXTENDED to a closed state opens a new closure (closure_id += 1).
/// post_price: stamped with the cluster clock.
fn market_update(program_id: &Address, m: &AccountView, auth: &AccountView, ix: u8, a: &[u8]) -> Res {
    signer(auth)?;
    let d = data(program_id, m, TAG_MARKET)?;
    if !eq32(d, M_AUTH, auth.address()) {
        return Err(UNAUTHORIZED);
    }
    if ix == 2 {
        let price = rd_u64(a, 0);
        if price == 0 {
            return Err(BAD_PARAMS);
        }
        wr(d, M_PRICE, price.to_le_bytes());
        wr(d, M_PRICE_AT, now()?.to_le_bytes());
        return Ok(());
    }
    let ([state], safe, close, reopen) = (rd::<1>(a, 0), rd_u16(a, 1), rd_i64(a, 3), rd_i64(a, 11));
    if state > REOPEN
        || safe > rd_u16(d, M_MAX)
        || close < 0
        || reopen < 0
        || (close != 0 && reopen != 0 && reopen <= close)
    {
        return Err(BAD_PARAMS);
    }
    if (d[M_STATE] == OPEN || d[M_STATE] == EXTENDED) && state >= CLOSED {
        let id = u32::from_le_bytes(rd(d, M_CLOSURE));
        wr(d, M_CLOSURE, id.wrapping_add(1).to_le_bytes());
    }
    d[M_STATE] = state;
    wr(d, M_SAFE, safe.to_le_bytes());
    wr(d, M_CLOSE, close.to_le_bytes());
    wr(d, M_REOPEN, reopen.to_le_bytes());
    Ok(())
}

/// 3. open_position / 4. adjust_position.
///
/// A change that neither adds debt nor removes collateral is always allowed (repaying never needs a price).
/// Anything riskier needs a live market, a fresh price and the limit that applies now.
fn set_position(
    program_id: &Address,
    p: &AccountView,
    m: &AccountView,
    owner: &AccountView,
    open: bool,
    a: &[u8],
) -> Res {
    signer(owner)?;
    if open {
        signer(p)?;
    }
    let (coll, debt) = (rd_u64(a, 0), rd_u64(a, 8));
    let md = data(program_id, m, TAG_MARKET)?;
    let d = data(program_id, p, if open { 0 } else { TAG_POSITION })?;
    let (old_coll, old_debt) = if open {
        (0, 0)
    } else {
        if !eq32(d, P_OWNER, owner.address()) || !eq32(d, P_MARKET, m.address()) {
            return Err(UNAUTHORIZED);
        }
        (rd_u64(d, P_COLL), rd_u64(d, P_DEBT))
    };

    if debt > 0 && (debt > old_debt || coll < old_coll) {
        let t = now()?;
        let limit = limit_bps(md[M_STATE], rd_u16(md, M_MAX), rd_u16(md, M_SAFE), rd_i64(md, M_CLOSE), t)
            .ok_or(MARKET_CLOSED)?;
        if t.saturating_sub(rd_i64(md, M_PRICE_AT)) > MAX_PRICE_AGE_SECS {
            return Err(STALE_PRICE);
        }
        if !within(debt, coll, rd_u64(md, M_PRICE), limit) {
            return Err(OVER_LIMIT);
        }
    }

    if open {
        d[0] = TAG_POSITION;
        wr(d, P_OWNER, *owner.address().as_array());
        wr(d, P_MARKET, *m.address().as_array());
    }
    wr(d, P_COLL, coll.to_le_bytes());
    wr(d, P_DEBT, debt.to_le_bytes());
    // A Bell flag stays until the position is back within the closure-safe LTV (at the last posted price).
    if debt == 0 || within(debt, coll, rd_u64(md, M_PRICE), rd_u16(md, M_SAFE)) {
        d[P_FLAG] = 0;
    }
    Ok(())
}

/// 5. bell_check. Permissionless. Inside the Bell window (or once the market is no longer open), flags a position
/// above the closure-safe LTV and clears the flag of one back under it. Outside the window it fails, so nobody can
/// flag positions early.
fn bell_check(program_id: &Address, p: &AccountView, m: &AccountView) -> Res {
    let md = data(program_id, m, TAG_MARKET)?;
    let d = data(program_id, p, TAG_POSITION)?;
    if !eq32(d, P_MARKET, m.address()) {
        return Err(BAD_ACCOUNT);
    }
    let t = now()?;
    let close = rd_i64(md, M_CLOSE);
    if effective_state(md[M_STATE], close, t) == OPEN && !in_bell(close, t) {
        return Err(NOT_IN_BELL);
    }
    d[P_FLAG] = !within(rd_u64(d, P_DEBT), rd_u64(d, P_COLL), rd_u64(md, M_PRICE), rd_u16(md, M_SAFE)) as u8;
    Ok(())
}

/// 6. close. Closes a market (by its authority) or a position (by its owner) and returns the rent to the signer.
fn close(program_id: &Address, a: &AccountView, to: &AccountView) -> Res {
    signer(to)?;
    // A market (tag 1) is closed by its authority, a position (tag 2) by its owner.
    let d = data(program_id, a, TAG_MARKET).or_else(|_| data(program_id, a, TAG_POSITION))?;
    if !eq32(d, if d[0] == TAG_MARKET { M_AUTH } else { P_OWNER }, to.address()) {
        return Err(UNAUTHORIZED);
    }
    let (mut a, mut to) = (*a, *to);
    to.set_lamports(to.lamports() + a.lamports());
    a.set_lamports(0);
    // SAFETY: no reference to `a`'s data is alive.
    unsafe { a.close_unchecked() };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOSE: i64 = 1_000_000;

    #[test]
    fn fails_closed_after_close() {
        assert_eq!(effective_state(OPEN, CLOSE, CLOSE - 1), OPEN);
        assert_eq!(effective_state(OPEN, CLOSE, CLOSE), CLOSED);
        assert_eq!(effective_state(EXTENDED, 0, 5), CLOSED);
        assert_eq!(effective_state(HALTED, CLOSE, 0), HALTED);
    }

    #[test]
    fn limit_follows_the_clock() {
        assert_eq!(limit_bps(OPEN, 7500, 5000, CLOSE, CLOSE - BELL_WINDOW_SECS - 1), Some(7500));
        assert_eq!(limit_bps(OPEN, 7500, 5000, CLOSE, CLOSE - BELL_WINDOW_SECS), Some(5000));
        assert_eq!(limit_bps(EXTENDED, 7500, 5000, CLOSE, 0), Some(5000));
        assert_eq!(limit_bps(CLOSED, 7500, 5000, CLOSE, 0), None);
        assert_eq!(limit_bps(REOPEN, 7500, 5000, CLOSE, 0), None);
        assert_eq!(limit_bps(OPEN, 7500, 5000, CLOSE, CLOSE + 1), None);
    }

    #[test]
    fn ltv_math() {
        // 10 shares at $200 = $2,000; 75% → $1,500.
        let (coll, price) = (10 * ONE as u64, 200 * ONE as u64);
        assert!(within(1_500 * ONE as u64, coll, price, 7500));
        assert!(!within(1_500 * ONE as u64 + 1, coll, price, 7500));
        assert!(within(0, 0, price, 0));
        assert!(within(u64::MAX, u64::MAX, u64::MAX, 9999));
        assert!(!within(u64::MAX, 1, 1, 9999));
    }
}
