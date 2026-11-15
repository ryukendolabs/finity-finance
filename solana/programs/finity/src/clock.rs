//! The market clock (§8.2.2) and the borrow limit it drives.
//!
//! Inputs are the venue calendar, guardian restrictions, corporate actions and the market's price. The sequencer
//! gap check (R-20) applies to rollup sequencers and has no Solana counterpart. A REOPEN ends when `complete_reopen` runs:
//! after the reopen auction's queue window, once every loan of its lot has settled.

use anchor_lang::prelude::*;

use crate::{constants::*, error::FinityError, math::*, risk, state::*};

fn scheduled(t: u8) -> bool {
    matches!(t, CLOSURE_OVERNIGHT | CLOSURE_WEEKEND | CLOSURE_HOLIDAY_WEEKEND)
}

fn more_restrictive(a: ClockState, b: ClockState) -> ClockState {
    if b.rank() > a.rank() {
        b
    } else {
        a
    }
}

/// First session index with `close > t` at or after `from` (sessions are increasing).
fn next_session_closing_after(s: &[SessionRec], from: u32, t: i64) -> Option<u32> {
    (from as usize..s.len()).find(|&i| s[i].close as i64 > t).map(|i| i as u32)
}

/// Starts the clock at `now`: closes already in the past are skipped, so the first poke opens none of them.
/// Starts the clock at `now`. Closes before the most recent one are skipped; the most recent close (the closure we
/// may be inside right now) is left for the first poke to open, with its own type and reopen time.
pub fn init(clock: &mut AssetClock, s: &[SessionRec], now: i64) {
    let first_live = (0..s.len()).find(|&i| s[i].ext_close as i64 > now).unwrap_or(s.len());
    clock.session_cursor = first_live as u32;
    let first_unclosed = (0..s.len()).find(|&i| s[i].close as i64 > now).unwrap_or(s.len());
    // Inside the closure that follows the last close (the next session hasn't opened yet): leave that close for
    // the first poke. Otherwise every past close is history.
    let inside = first_unclosed > 0 && s.get(first_unclosed).map_or(true, |n| now < n.open as i64);
    clock.closed_sessions = if inside { first_unclosed - 1 } else { first_unclosed } as u32;
    clock.state = ClockState::Closed;
}

/// Runs the transition algorithm and writes the market's coarse session. Idempotent within a slot.
pub fn poke(clock: &mut AssetClock, s: &[SessionRec], market: &mut Market, now: i64) -> Result<ClockState> {
    let count = s.len() as u32;

    // 2. Advance the cursor to the first session not yet over and read the calendar state.
    while clock.session_cursor < count && (s[clock.session_cursor as usize].ext_close as i64) <= now {
        clock.session_cursor += 1;
    }
    let cal_state = match s.get(clock.session_cursor as usize) {
        Some(c) if now >= c.open as i64 && now < c.close as i64 => ClockState::Regular,
        Some(c) if now >= c.ext_open as i64 && now < c.ext_close as i64 => ClockState::Extended,
        _ => ClockState::Closed,
    };

    // 3. One scheduled closure per scheduled close, even if pokes were missed.
    while clock.closed_sessions < count {
        let idx = clock.closed_sessions as usize;
        if now < s[idx].close as i64 {
            break;
        }
        clock.closure_id += 1;
        clock.venue_epoch = idx as u32;
        clock.closure_type = s[idx].closure_type_after;
        clock.close_at = s[idx].close as i64;
        clock.reopen_at = s.get(idx + 1).map(|n| n.open as i64).unwrap_or(0);
        clock.reopen_pending = true;
        clock.open_print = 0;
        clock.open_print_at = 0;
        clock.reopen_ends_at = 0;
        clock.ref_price = market.price;
        clock.ref_time = market.price_updated_at;
        clock.closed_sessions += 1;
    }

    // 4–6. Guardian and corporate-action inputs; the most restrictive wins.
    let mut target = cal_state;
    if clock.restriction_until > now {
        target = more_restrictive(target, clock.restriction);
    }
    if clock.corporate_action {
        target = ClockState::CorpAction;
    }
    // Pre/post-market inside a scheduled closure is still the closure.
    if clock.reopen_pending && scheduled(clock.closure_type) && target == ClockState::Extended {
        target = ClockState::Closed;
    }
    // A non-calendar closure (halt, guardian close, corporate action) also opens a closure.
    if !clock.reopen_pending && target.rank() >= ClockState::Closed.rank() {
        clock.closure_id += 1;
        clock.venue_epoch = clock.session_cursor;
        clock.closure_type = if target == ClockState::CorpAction { CLOSURE_CORP_ACTION } else { CLOSURE_HALT };
        clock.close_at = now;
        clock.reopen_at = match s.get(clock.session_cursor as usize) {
            Some(c) if c.open as i64 > now => c.open as i64,
            _ => s.get(clock.session_cursor as usize + 1).map(|n| n.open as i64).unwrap_or(0),
        };
        clock.reopen_pending = true;
        clock.open_print = 0;
        clock.open_print_at = 0;
        clock.reopen_ends_at = 0;
        clock.ref_price = market.price;
        clock.ref_time = market.price_updated_at;
    }

    // 7–8. Reopen: the first REGULAR after a closure waits for an open print (a price observed after the
    // reopen), then holds REOPEN.
    if clock.reopen_pending && target == ClockState::Regular {
        if clock.open_print == 0 && market.price_updated_at >= clock.reopen_at.max(clock.close_at) {
            clock.open_print = market.price;
            clock.open_print_at = now;
            // REOPEN holds until `complete_reopen`: the queue window is over and the reopen auction settled.
            clock.reopen_ends_at = i64::MAX;
        }
        target = if clock.open_print == 0 {
            ClockState::Closed
        } else if now < clock.reopen_ends_at {
            ClockState::Reopen
        } else {
            clock.reopen_pending = false;
            ClockState::Regular
        };
    }

    // 9. Commit.
    clock.state = target;
    market.session = match target {
        ClockState::Regular => Session::Open,
        ClockState::Halted | ClockState::CorpAction => Session::Halted,
        _ => Session::Closed,
    };

    // 10. Next scheduled close and its Bell times.
    match next_session_closing_after(s, clock.session_cursor, now) {
        Some(j) => {
            let c = s[j as usize];
            clock.next_close_at = c.close as i64;
            clock.next_closure_type = c.closure_type_after;
            clock.next_reopen_at = s.get(j as usize + 1).map(|n| n.open as i64).unwrap_or(0);
            clock.bell_window_at = c.close as i64 - BELL_WINDOW_SECS;
            clock.bell_at = c.close as i64 - BELL_DEADLINE_SECS;
        }
        None => {
            clock.next_close_at = 0;
            clock.next_closure_type = CLOSURE_NONE;
            clock.next_reopen_at = 0;
            clock.bell_window_at = 0;
            clock.bell_at = 0;
        }
    }
    Ok(target)
}

/// ceil_days(reopen − close) (R-07); unknown ends are an open-ended closure.
pub fn closure_days(close_at: i64, reopen_at: i64) -> Result<u16> {
    require!(close_at > 0 && reopen_at > close_at, FinityError::ClosureOpenEnded);
    Ok(((reopen_at - close_at + DAY_SECS - 1) / DAY_SECS) as u16)
}

/// The closure the safe rule looks at: the one in progress, else the next scheduled one. Halts and corporate
/// actions use the holiday-weekend set, the most conservative calibrated type.
pub fn safe_rule_closure(clock: &AssetClock) -> Result<(u8, u16)> {
    let (t, days) = if clock.reopen_pending {
        (clock.closure_type, closure_days(clock.close_at, clock.reopen_at)?)
    } else {
        (clock.next_closure_type, closure_days(clock.next_close_at, clock.next_reopen_at)?)
    };
    let t = if scheduled(t) { t } else { CLOSURE_HOLIDAY_WEEKEND };
    Ok((t, days))
}

/// The three risk sets of a market, by closure type.
pub struct RiskSets<'a> {
    pub overnight: &'a RiskSet,
    pub weekend: &'a RiskSet,
    pub holiday: &'a RiskSet,
}

impl RiskSets<'_> {
    pub fn get(&self, t: u8) -> &RiskSet {
        match t {
            CLOSURE_OVERNIGHT => self.overnight,
            CLOSURE_WEEKEND => self.weekend,
            _ => self.holiday,
        }
    }
}

/// Safe LTV (WAD) of a market for closure type `t`, capped at its max LTV.
pub fn safe_ltv_wad(market: &Market, cfg: &RiskConfig, set: &RiskSet) -> Result<u128> {
    safe_ltv_wad_capped(market.max_ltv_bps, cfg, set)
}

/// Safe LTV capped at `max_ltv_bps` (the guardian's haircut lowers it).
pub fn safe_ltv_wad_capped(max_ltv_bps: u16, cfg: &RiskConfig, set: &RiskSet) -> Result<u128> {
    let max = max_ltv_bps as u128 * WAD / BPS as u128;
    risk::safe_ltv(&set.z_tail, set.n, cfg.alpha as u128, set.sigma as u128, set.dividend as u128, cfg.kappa as u128, max)
}

/// Checks `debt` against the limit that applies now (MarketLib.limit): max LTV in the regular session before
/// the Bell window; otherwise the closure's safe LTV against the debt projected to the reopen. Borrowing is
/// paused during REOPEN and corporate actions.
pub fn check_limit(
    market: &Market,
    clock: &AssetClock,
    cfg: &RiskConfig,
    sets: &RiskSets,
    collateral: u64,
    debt: u64,
    covered: bool,
    max_ltv_bps: u16,
    now: i64,
) -> Result<()> {
    require!(
        !matches!(clock.state, ClockState::Reopen | ClockState::CorpAction),
        FinityError::BorrowPaused
    );
    // P4: inside a closure a price can lower collateral value, never raise it above the close.
    let price = if clock.reopen_pending && clock.ref_price > 0 { market.price.min(clock.ref_price) } else { market.price };
    let value = market.collateral_value_at(collateral, price)?;
    // A loan covered for the upcoming closure keeps max LTV through the Bell window.
    let open_rule = clock.state == ClockState::Regular && (clock.bell_window_at == 0 || now < clock.bell_window_at || covered);
    if open_rule {
        require!(debt as u128 <= value * max_ltv_bps as u128 / BPS as u128, FinityError::BorrowLimitExceeded);
        return Ok(());
    }
    let (t, days) = safe_rule_closure(clock)?;
    let ltv = safe_ltv_wad_capped(max_ltv_bps, cfg, sets.get(t))?;
    let projected = risk::projected_debt(debt as u128, market.borrow_rate()?, days)?;
    require!(projected <= mul_div(value, ltv, WAD)?, FinityError::BorrowLimitExceeded);
    Ok(())
}
