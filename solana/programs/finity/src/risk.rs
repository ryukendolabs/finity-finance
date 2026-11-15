//! Risk math ported from `crates/risk-core` (F-4.2 safe LTV, F-4.3 Gap Cover premium) with the same rounding.
//! risk-core itself can't be linked on-chain (alloy-primitives needs a newer rustc than Solana's toolchain), so
//! the tests run both implementations side by side and require identical outputs.
//!
//! Units: ratios WAD, amounts in loan base units, scenario gaps z as i16 thousandths of one σ, sorted ascending.

use anchor_lang::prelude::*;

use crate::{error::FinityError, math::*};

const THOUSAND: u128 = 1_000;

/// g = max(0, 1 + σ·z/1000 − d) × (1 − κ), rounded DOWN; σ·|z| rounded against the user.
pub fn gap_factor(z: i16, sigma: u128, dividend: u128, kappa: u128) -> Result<u128> {
    require!(kappa <= WAD, FinityError::InvalidRiskParams);
    let az = z.unsigned_abs() as u128;
    let base = if z >= 0 {
        WAD.checked_add(mul_div(sigma, az, THOUSAND)?).ok_or(FinityError::MathOverflow)?
    } else {
        WAD.saturating_sub(mul_div_up(sigma, az, THOUSAND)?)
    };
    mul_div(base.saturating_sub(dividend), WAD - kappa, WAD)
}

/// i* = ⌈α·N⌉ − 1.
pub fn quantile_index(n: u32, alpha: u128) -> Result<u32> {
    require!(n > 0 && alpha > 0 && alpha <= WAD, FinityError::InvalidRiskParams);
    let k = mul_div_up(alpha, n as u128, WAD)? as u32;
    Ok(k.saturating_sub(1))
}

/// LTV_safe = min(LTV_max, g(z_{i*})), rounded down. `tail` holds the lowest z values of a set of `n`.
pub fn safe_ltv(tail: &[i16], n: u32, alpha: u128, sigma: u128, dividend: u128, kappa: u128, max_ltv: u128) -> Result<u128> {
    let i = quantile_index(n, alpha)? as usize;
    require!(i < tail.len(), FinityError::ScenarioTailTooShort);
    Ok(gap_factor(tail[i], sigma, dividend, kappa)?.min(max_ltv))
}

/// Inputs of a premium quote (risk-core `PremiumParams`).
#[derive(Clone, Copy, Debug)]
pub struct PremiumParams {
    pub sigma: u128,
    pub dividend: u128,
    pub kappa: u128,
    pub collateral_value: u128,
    pub debt_projected: u128,
    pub closure_days: u16,
    pub util_after: u128,
    pub theta: u128,
    pub cost_of_cap: u128,
    pub eta: u128,
    pub beta: u128,
    pub min_premium: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PremiumQuote {
    pub premium: u128,
    pub expected_loss: u128,
    pub expected_shortfall: u128,
}

/// max(0, D − C × g(z)), C × g rounded down (the loss rounds up).
pub fn scenario_loss(z: i16, p: &PremiumParams) -> Result<u128> {
    let g = gap_factor(z, p.sigma, p.dividend, p.kappa)?;
    Ok(p.debt_projected.saturating_sub(mul_div(p.collateral_value, g, WAD)?))
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

/// π = max(minPremium, m(u) × [(1 + θ) E[L] + c τ ES_β]), m(u) = 1 + η u². Losses are a prefix of the ascending
/// set; the stored tail must reach a zero-loss scenario, otherwise the quote is refused rather than understated.
pub fn quote_cover(tail: &[i16], n: u32, p: &PremiumParams) -> Result<PremiumQuote> {
    require!(n > 0, FinityError::InvalidRiskParams);
    require!(p.beta <= WAD && p.kappa <= WAD, FinityError::InvalidRiskParams);
    let m = mul_div_up(WAD - p.beta, n as u128, WAD)?.max(1);
    let m = if m > n as u128 { n } else { m as u32 };
    require!((m as usize) <= tail.len(), FinityError::ScenarioTailTooShort);

    let (mut total, mut worst_m, mut i, mut ended) = (0u128, 0u128, 0u32, false);
    while (i as usize) < tail.len() && i < n {
        let l = scenario_loss(tail[i as usize], p)?;
        if l == 0 {
            ended = true;
            break;
        }
        total = total.checked_add(l).ok_or(FinityError::MathOverflow)?;
        if i < m {
            worst_m += l;
        }
        i += 1;
    }
    require!(ended || i == n, FinityError::ScenarioTailTooShort);
    let expected_loss = ceil_div(total, n as u128);
    let expected_shortfall = ceil_div(worst_m, m as u128);

    let tau = mul_div_up(p.closure_days as u128, WAD, 365)?;
    let loaded = mul_div_up(WAD + p.theta, expected_loss, WAD)?;
    let capital = mul_div_up(mul_div_up(p.cost_of_cap, tau, WAD)?, expected_shortfall, WAD)?;
    let base = loaded.checked_add(capital).ok_or(FinityError::MathOverflow)?;
    let mult = WAD + mul_div_up(p.eta, mul_div_up(p.util_after, p.util_after, WAD)?, WAD)?;
    let premium = mul_div_up(mult, base, WAD)?.max(p.min_premium);
    Ok(PremiumQuote { premium, expected_loss, expected_shortfall })
}

/// D_proj = D × (1 + r × days / 365), rounded up (R-08).
pub fn projected_debt(debt: u128, rate: u128, days: u16) -> Result<u128> {
    mul_div_up(debt, WAD + mul_div_up(rate, days as u128, 365)?, WAD)
}

/// base^n in WAD by square-and-multiply, each step rounded up (risk-core `pow_wad_up`).
fn pow_wad_up(base: u128, mut n: u64) -> Result<u128> {
    let (mut result, mut b) = (WAD, base);
    while n > 0 {
        if n & 1 == 1 {
            result = mul_div_up(result, b, WAD)?;
        }
        n >>= 1;
        if n > 0 {
            b = mul_div_up(b, b, WAD)?;
        }
    }
    Ok(result)
}

/// The lowest σ allowed after `days` whole days: current × 0.9^days, rounded up (R-15: down at most 10%/day).
pub fn sigma_min_allowed(current: u128, days: u64) -> Result<u128> {
    if current == 0 {
        return Ok(0);
    }
    mul_div_up(current, pow_wad_up(WAD * 9 / 10, days.min(400))?, WAD)
}


// ───────────── capacity (F-4.4, risk-core capacity.rs) and the Bell (F-4.2) ─────────────

/// Loss of one policy in joint scenario z: max(0, D_proj − C × g(z)), C × g rounded down (risk-core loss_vector).
pub fn policy_loss(z: i16, collateral_value: u128, debt_projected: u128, sigma: u128, dividend: u128, kappa: u128) -> Result<u64> {
    let g = gap_factor(z, sigma, dividend, kappa)?;
    to_u64(debt_projected.saturating_sub(mul_div(collateral_value, g, WAD)?))
}

/// `policy_loss` with g(z) already computed.
pub fn policy_loss_g(g: u128, collateral_value: u128, debt_projected: u128) -> Result<u64> {
    to_u64(debt_projected.saturating_sub(mul_div(collateral_value, g, WAD)?))
}

/// `uncovered_bound` with g(z) already computed.
pub fn uncovered_bound_g(g: u128, collateral_unc: u128, safe_ltv: u128) -> Result<u64> {
    if g >= safe_ltv {
        return Ok(0);
    }
    to_u64(mul_div_up(collateral_unc, safe_ltv - g, WAD)?)
}

/// g(z_j) for every scenario of a joint column (computed once, shared by the capacity terms).
pub fn gap_factors(z: &[i16], sigma: u128, dividend: u128, kappa: u128) -> Result<Vec<u128>> {
    z.iter().map(|&z| gap_factor(z, sigma, dividend, kappa)).collect()
}

/// B_j = C_unc × max(0, LTV_safe − g_j), rounded up: the most uncovered loans (all at or below the safe LTV after
/// the Bell) can lose in scenario j.
pub fn uncovered_bound(collateral_unc: u128, safe_ltv: u128, z: i16, sigma: u128, dividend: u128, kappa: u128) -> Result<u64> {
    let g = gap_factor(z, sigma, dividend, kappa)?;
    if g >= safe_ltv {
        return Ok(0);
    }
    to_u64(mul_div_up(collateral_unc, safe_ltv - g, WAD)?)
}

/// u = max_j Λ_j / J (rounded up; u128::MAX when J = 0 and some loss is positive).
pub fn utilisation(worst_loss: u128, equity: u128) -> Result<u128> {
    if worst_loss == 0 {
        Ok(0)
    } else if equity == 0 {
        Ok(u128::MAX)
    } else {
        mul_div_up(worst_loss, WAD, equity)
    }
}

pub const BELL_SAFE: u8 = 0;
pub const BELL_NEEDS_ACTION: u8 = 1;
pub const BELL_COVERED: u8 = 2;

/// ⌈D / C⌉ in WAD (0 without debt, u128::MAX without collateral).
pub fn ltv_up(debt: u128, collateral_value: u128) -> Result<u128> {
    if debt == 0 {
        return Ok(0);
    }
    if collateral_value == 0 {
        return Ok(u128::MAX);
    }
    mul_div_up(debt, WAD, collateral_value)
}

/// Bell status at the closure's safe LTV and the two cures: repay ΔD, or add collateral worth ΔC (risk-core
/// bell_status).
pub fn bell_status(collateral_value: u128, debt_projected: u128, ltv_safe: u128, covered: bool) -> Result<(u8, u128, u128)> {
    if covered {
        return Ok((BELL_COVERED, 0, 0));
    }
    if ltv_up(debt_projected, collateral_value)? <= ltv_safe {
        return Ok((BELL_SAFE, 0, 0));
    }
    let repay = debt_projected.saturating_sub(mul_div(ltv_safe, collateral_value, WAD)?);
    let add = if ltv_safe == 0 { u128::MAX } else { mul_div_up(debt_projected, WAD, ltv_safe)?.saturating_sub(collateral_value) };
    Ok((BELL_NEEDS_ACTION, repay, add))
}


// ───────────── auctions (F-4.5a–d, risk-core liquidation.rs and clearing.rs) ─────────────
// Prices here are WAD per whole token, as in risk-core; the program stores USDC base units per token, and
// `price_wad` converts exactly (× 10^12 for 6-decimal USDC).

pub const LOAN_DECIMALS: u8 = 6;

pub fn price_wad(price_usdc: u64) -> u128 {
    price_usdc as u128 * 1_000_000_000_000
}

fn u(x: u128) -> U256 {
    U256::from(x)
}

fn pow10(d: u8) -> U256 {
    U256::from(10u64).pow(U256::from(d))
}

fn narrow(x: U256) -> Result<u128> {
    u128::try_from(x).map_err(|_| error!(FinityError::MathOverflow))
}

fn mdd(a: U256, b: U256, d: U256) -> U256 {
    a * b / d
}

fn mdu(a: U256, b: U256, d: U256) -> U256 {
    let p = a * b;
    p / d + if (p % d).is_zero() { U256::zero() } else { U256::one() }
}

/// value(q, V) = q × V × 10^loanDec / (10^collDec × 1e18), rounded down.
pub fn value_wad(q: u128, v_wad: u128, coll_dec: u8) -> Result<u128> {
    narrow(mdd(u(q) * u(v_wad), pow10(LOAN_DECIMALS), pow10(coll_dec) * u(WAD)))
}

/// F-4.5a: x = (H*·D − q·P_hf·LT) / (H*·R·(1 − λ) − P_hf·LT), rounded up, clamped to [0, q] (full close when the
/// denominator is not positive).
pub fn liquidation_lot(debt: u128, qty: u128, sizing: u128, hf_price: u128, lt: u128, h_star: u128, lambda: u128, coll_dec: u8) -> Result<u128> {
    require!(lambda <= WAD && lt <= WAD * 10, FinityError::InvalidRiskParams);
    if qty == 0 {
        return Ok(0);
    }
    let scale = pow10(coll_dec);
    let d_usd = u(debt) * pow10(18 - LOAN_DECIMALS);
    let lhs = u(h_star) * d_usd;
    let rhs = mdd(u(qty), u(hf_price) * u(lt), scale);
    if lhs <= rhs {
        return Ok(0);
    }
    let num = lhs - rhs;
    let hr = mdd(u(h_star) * u(sizing), u(WAD - lambda), u(WAD));
    let pl = u(hf_price) * u(lt);
    if hr <= pl {
        return Ok(qty);
    }
    let x = narrow(mdu(num, scale, hr - pl))?;
    Ok(x.min(qty))
}

/// F-4.5b: x = (D_proj − LTV_s·q·V) / ((1 − λ_pre)·R_pre − LTV_s·V), rounded up, clamped to [0, q].
pub fn preclose_lot(debt: u128, qty: u128, valuation: u128, reserve: u128, target_ltv: u128, lambda_pre: u128, coll_dec: u8) -> Result<u128> {
    require!(lambda_pre <= WAD && target_ltv <= WAD, FinityError::InvalidRiskParams);
    if qty == 0 {
        return Ok(0);
    }
    let scale = pow10(coll_dec);
    let lhs = u(debt) * pow10(18 - LOAN_DECIMALS) * u(WAD);
    let rhs = mdd(u(qty), u(target_ltv) * u(valuation), scale);
    if lhs <= rhs {
        return Ok(0);
    }
    let sell = u(WAD - lambda_pre) * u(reserve);
    let keep = u(target_ltv) * u(valuation);
    if sell <= keep {
        return Ok(qty);
    }
    let x = narrow(mdu(lhs - rhs, scale, sell - keep))?;
    Ok(x.min(qty))
}

/// Settlement of one position at the blended price p̄ (F-4.5d).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Settlement {
    pub proceeds: u128,
    pub penalty: u128,
    pub repaid: u128,
    pub refund: u128,
    pub shortfall: u128,
    pub debt_after: u128,
    pub full_close: bool,
}

/// Partial → penalty λP, debt − (1 − λ)P; full and solvent → penalty min(λP, P − D), refund the rest; full and
/// short → no penalty, shortfall D − P.
pub fn settle_position(x: u128, q_before: u128, blended: u128, debt: u128, lambda: u128, coll_dec: u8) -> Result<Settlement> {
    require!(x <= q_before && lambda <= WAD, FinityError::InvalidRiskParams);
    let p = value_wad(x, blended, coll_dec)?;
    let pen_full = mul_div(lambda, p, WAD)?;
    let mut s = Settlement { proceeds: p, full_close: x == q_before, ..Default::default() };
    if !s.full_close {
        let net = p - pen_full;
        s.penalty = pen_full;
        s.repaid = net.min(debt);
        s.refund = net - s.repaid;
        s.debt_after = debt - s.repaid;
    } else if p >= debt {
        s.penalty = pen_full.min(p - debt);
        s.repaid = debt;
        s.refund = p - debt - s.penalty;
    } else {
        s.repaid = p;
        s.shortfall = debt - p;
    }
    Ok(s)
}

/// F-4.5c: bids ≥ R by price descending fill the lot; everyone pays p* (the last price needed); at p* the rest
/// is split pro rata, remainders one unit each in ascending tie-key order. Returns (p*, fills, q_pool).
pub fn clear(qtys: &[u128], prices: &[u128], tie_keys: &[[u8; 32]], lot: u128, reserve: u128) -> Result<(u128, Vec<u128>, u128)> {
    let n = qtys.len();
    require!(prices.len() == n && tie_keys.len() == n, FinityError::InvalidRiskParams);
    let mut fills = vec![0u128; n];
    let mut idx: Vec<usize> = (0..n).filter(|&i| prices[i] >= reserve && qtys[i] > 0).collect();
    idx.sort_unstable_by(|&a, &b| prices[b].cmp(&prices[a]).then(tie_keys[a].cmp(&tie_keys[b])));
    let (mut remaining, mut p_star, mut g) = (lot, 0u128, 0usize);
    while g < idx.len() && remaining > 0 {
        let price = prices[idx[g]];
        let (mut end, mut total) = (g, 0u128);
        while end < idx.len() && prices[idx[end]] == price {
            total = total.checked_add(qtys[idx[end]]).ok_or(FinityError::MathOverflow)?;
            end += 1;
        }
        p_star = price;
        if total <= remaining {
            for &i in &idx[g..end] {
                fills[i] = qtys[i];
            }
            remaining -= total;
        } else {
            let mut assigned = 0u128;
            for &i in &idx[g..end] {
                let f = mul_div(qtys[i], remaining, total)?;
                fills[i] = f;
                assigned += f;
            }
            let mut leftover = remaining - assigned;
            for &i in &idx[g..end] {
                if leftover == 0 {
                    break;
                }
                if fills[i] < qtys[i] {
                    fills[i] += 1;
                    leftover -= 1;
                }
            }
            remaining = 0;
        }
        g = end;
    }
    Ok((p_star, fills, remaining))
}

/// p̄ = ((Q − Q_pool) p* + Q_pool R) / Q, rounded down.
pub fn blended_price(lot: u128, p_star: u128, q_pool: u128, reserve: u128) -> Result<u128> {
    if lot == 0 {
        return Ok(0);
    }
    require!(q_pool <= lot, FinityError::InvalidRiskParams);
    narrow((u(lot - q_pool) * u(p_star) + u(q_pool) * u(reserve)) / u(lot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use finity_risk_core as rc;
    use proptest::prelude::*;

    fn u(x: u128) -> rc::U256 {
        rc::U256::from(x)
    }

    const H: u128 = 1_100_000_000_000_000_000;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        #[test]
        fn gap_factor_matches_risk_core(z in any::<i16>(), sigma in 0u128..WAD, d in 0u128..WAD / 10, k in 0u128..WAD / 5) {
            let ours = gap_factor(z, sigma, d, k).unwrap();
            let theirs = rc::gap_factor(z, u(sigma), u(d), u(k)).unwrap();
            prop_assert_eq!(u(ours), theirs);
        }

        #[test]
        fn safe_ltv_matches_risk_core(mut zs in proptest::collection::vec(any::<i16>(), 1..300), sigma in 1u128..WAD / 5, alpha in 1u128..WAD / 20, k in 0u128..WAD / 10, max in 1u128..WAD) {
            zs.sort();
            let n = zs.len() as u32;
            let ours = safe_ltv(&zs, n, alpha, sigma, 0, k, max).unwrap();
            let theirs = rc::safe_ltv_from_set(&rc::SliceZ(&zs), u(alpha), u(sigma), rc::U256::ZERO, u(k), u(max)).unwrap();
            prop_assert_eq!(u(ours), theirs);
        }

        #[test]
        fn premium_matches_risk_core(
            mut zs in proptest::collection::vec(-20_000i16..20_000, 40..400),
            sigma in WAD / 1000..WAD / 20,
            c in 1_000_000u128..10_000_000_000_000,
            ltv in 1u128..95,
            days in 1u16..5,
            util in 0u128..WAD,
        ) {
            zs.sort();
            let n = zs.len() as u32;
            let p = PremiumParams {
                sigma, dividend: 0, kappa: WAD * 3 / 100, collateral_value: c, debt_projected: c * ltv / 100,
                closure_days: days, util_after: util, theta: WAD, cost_of_cap: WAD * 15 / 100, eta: 4 * WAD,
                beta: WAD * 975 / 1000, min_premium: 500_000,
            };
            let ours = quote_cover(&zs, n, &p).unwrap();
            let rp = rc::PremiumParams {
                sigma: u(p.sigma), dividend: rc::U256::ZERO, kappa: u(p.kappa), collateral_value: u(c),
                debt_projected: u(p.debt_projected), closure_days: days, util_after: u(util), theta: u(p.theta),
                cost_of_cap: u(p.cost_of_cap), eta: u(p.eta), beta: u(p.beta), min_premium: u(p.min_premium),
            };
            let theirs = rc::quote_cover(&rc::SliceZ(&zs), &rp).unwrap();
            prop_assert_eq!(u(ours.premium), theirs.premium);
            prop_assert_eq!(u(ours.expected_loss), theirs.expected_loss);
            prop_assert_eq!(u(ours.expected_shortfall), theirs.expected_shortfall);
        }

        #[test]
        fn projected_debt_matches_risk_core(d in 0u128..1_000_000_000_000_000, r in 0u128..WAD, days in 0u16..10) {
            prop_assert_eq!(u(projected_debt(d, r, days).unwrap()), rc::projected_debt(u(d), u(r), days).unwrap());
        }

        #[test]
        fn sigma_floor_matches_risk_core(s in 0u128..WAD, days in 0u64..500) {
            prop_assert_eq!(u(sigma_min_allowed(s, days).unwrap()), rc::sigma_min_allowed(u(s), days).unwrap());
        }

        #[test]
        fn capacity_pieces_match_risk_core(
            zs in proptest::collection::vec(any::<i16>(), 1..64),
            c in 0u128..10_000_000_000_000,
            ltv in 0u128..100,
            sigma in 0u128..WAD / 10,
            safe in 0u128..WAD,
            k in 0u128..WAD / 10,
        ) {
            let d = c * ltv / 100;
            let ours: Vec<u64> = zs.iter().map(|&z| policy_loss(z, c, d, sigma, 0, k).unwrap()).collect();
            let theirs = rc::loss_vector(&rc::SliceZ(&zs), u(c), u(d), u(sigma), rc::U256::ZERO, u(k)).unwrap();
            prop_assert_eq!(&ours, &theirs);
            let gs = gap_factors(&zs, sigma, 0, k).unwrap();
            let via_g: Vec<u64> = gs.iter().map(|&g| policy_loss_g(g, c, d).unwrap()).collect();
            prop_assert_eq!(&via_g, &ours);
            for (i, &z) in zs.iter().enumerate() {
                prop_assert_eq!(uncovered_bound_g(gs[i], c, safe).unwrap(), uncovered_bound(c, safe, z, sigma, 0, k).unwrap());
                let ours = uncovered_bound(c, safe, z, sigma, 0, k).unwrap();
                let theirs = rc::uncovered_bound(u(c), u(safe), u(sigma), rc::U256::ZERO, u(k), z).unwrap();
                prop_assert_eq!(u(ours as u128), theirs);
            }
        }

        #[test]
        fn bell_status_matches_risk_core(c in 0u128..10_000_000_000_000, d in 0u128..10_000_000_000_000, safe in 0u128..WAD, covered in any::<bool>()) {
            let (s, r, a) = bell_status(c, d, safe, covered).unwrap();
            let t = rc::bell_status(u(c), u(d), u(safe), covered).unwrap();
            prop_assert_eq!(s, t.status);
            prop_assert_eq!(u(r), t.cure_repay);
            if a == u128::MAX { prop_assert_eq!(t.cure_collateral_value, rc::U256::MAX); } else { prop_assert_eq!(u(a), t.cure_collateral_value); }
        }

        #[test]
        fn lots_match_risk_core(
            debt in 0u128..10_000_000_000_000, qty in 0u128..10_000_000_000, p in 1u128..2_000_000_000, r in 1u128..2_000_000_000,
            lt in WAD / 2..WAD, lam in 0u128..WAD / 10, tgt in 0u128..WAD,
        ) {
            let (pw, rw) = (price_wad(p as u64), price_wad(r as u64));
            prop_assert_eq!(
                u(liquidation_lot(debt, qty, rw, pw, lt, H, lam, 6).unwrap()),
                rc::liquidation_lot(u(debt), u(qty), u(rw), u(pw), u(lt), u(H), u(lam), 6, 6).unwrap()
            );
            prop_assert_eq!(
                u(preclose_lot(debt, qty, pw, rw, tgt, lam, 6).unwrap()),
                rc::preclose_lot(u(debt), u(qty), u(pw), u(rw), u(tgt), u(lam), 6, 6).unwrap()
            );
            let x = qty / 2;
            let ours = settle_position(x, qty, pw, debt, lam, 6).unwrap();
            let t = rc::settle_position(u(x), u(qty), u(pw), u(debt), u(lam), 6, 6).unwrap();
            prop_assert_eq!((u(ours.proceeds), u(ours.penalty), u(ours.repaid), u(ours.refund), u(ours.shortfall), u(ours.debt_after), ours.full_close),
                (t.proceeds, t.penalty, t.repaid, t.refund, t.shortfall, t.debt_after, t.full_close));
            let full = settle_position(qty, qty, pw, debt, lam, 6).unwrap();
            let t = rc::settle_position(u(qty), u(qty), u(pw), u(debt), u(lam), 6, 6).unwrap();
            prop_assert_eq!((u(full.repaid), u(full.refund), u(full.shortfall), u(full.penalty)), (t.repaid, t.refund, t.shortfall, t.penalty));
        }

        #[test]
        fn clearing_matches_risk_core(
            bids in proptest::collection::vec((0u128..1_000_000, 1u128..50u128, any::<[u8; 32]>()), 0..16),
            lot in 0u128..5_000_000, reserve in 1u128..50,
        ) {
            let qtys: Vec<u128> = bids.iter().map(|b| b.0).collect();
            let prices: Vec<u128> = bids.iter().map(|b| b.1 * WAD).collect();
            let keys: Vec<[u8; 32]> = bids.iter().map(|b| b.2).collect();
            let (p, fills, qp) = clear(&qtys, &prices, &keys, lot, reserve * WAD).unwrap();
            let t = rc::clear(
                &qtys.iter().map(|&q| u(q)).collect::<Vec<_>>(),
                &prices.iter().map(|&q| u(q)).collect::<Vec<_>>(),
                &keys.iter().map(|k| alloy_primitives::B256::from(*k)).collect::<Vec<_>>(),
                u(lot), u(reserve * WAD),
            ).unwrap();
            prop_assert_eq!(u(p), t.p_star);
            prop_assert_eq!(fills.iter().map(|&f| u(f)).collect::<Vec<_>>(), t.fills);
            prop_assert_eq!(u(qp), t.q_pool);
            prop_assert_eq!(u(blended_price(lot, p, qp, reserve * WAD).unwrap()), rc::blended_price(u(lot), t.p_star, t.q_pool, u(reserve * WAD)).unwrap());
        }
    }
}
