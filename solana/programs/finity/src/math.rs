//! Fixed-point math with every rounding direction fixed by the protocol spec:
//! the kinked rate model (risk-core `rates.rs`) and share conversions (§7.2).

use anchor_lang::prelude::*;

use crate::error::FinityError;

mod wide {
    // Kept out of the Anchor prelude: the macro expects std's two-parameter `Result`.
    uint::construct_uint! {
        pub struct U256(4);
    }
}
pub use wide::U256;

pub const WAD: u128 = 1_000_000_000_000_000_000;
pub const YEAR_SECS: u128 = 365 * 24 * 60 * 60;

/// Borrow shares: virtual offsets of 1e6 shares and 1 asset (inflation attack, §7.2).
pub const VIRTUAL_SHARES: u128 = 1_000_000;
pub const VIRTUAL_ASSETS: u128 = 1;

/// a × b / d rounded down. Native u128 when the product fits (the common case, ~10× cheaper on-chain), a
/// 256-bit intermediate otherwise; both give the exact floor.
pub fn mul_div(a: u128, b: u128, d: u128) -> Result<u128> {
    require!(d != 0, FinityError::MathOverflow);
    if let Some(p) = a.checked_mul(b) {
        return Ok(p / d);
    }
    let q = U256::from(a) * U256::from(b) / U256::from(d);
    u128::try_from(q).map_err(|_| error!(FinityError::MathOverflow))
}

/// a × b / d rounded up.
pub fn mul_div_up(a: u128, b: u128, d: u128) -> Result<u128> {
    require!(d != 0, FinityError::MathOverflow);
    if let Some(p) = a.checked_mul(b) {
        return Ok(p / d + u128::from(p % d != 0));
    }
    let p = U256::from(a) * U256::from(b);
    let d = U256::from(d);
    let q = p / d + if (p % d).is_zero() { U256::zero() } else { U256::one() };
    u128::try_from(q).map_err(|_| error!(FinityError::MathOverflow))
}

pub fn to_u64(x: u128) -> Result<u64> {
    u64::try_from(x).map_err(|_| error!(FinityError::MathOverflow))
}

// ───────────── shares ─────────────

pub fn to_shares_down(assets: u128, total_assets: u128, total_shares: u128, vs: u128, va: u128) -> Result<u128> {
    mul_div(assets, total_shares + vs, total_assets + va)
}
pub fn to_shares_up(assets: u128, total_assets: u128, total_shares: u128, vs: u128, va: u128) -> Result<u128> {
    mul_div_up(assets, total_shares + vs, total_assets + va)
}
pub fn to_assets_down(shares: u128, total_assets: u128, total_shares: u128, vs: u128, va: u128) -> Result<u128> {
    mul_div(shares, total_assets + va, total_shares + vs)
}
pub fn to_assets_up(shares: u128, total_assets: u128, total_shares: u128, vs: u128, va: u128) -> Result<u128> {
    mul_div_up(shares, total_assets + va, total_shares + vs)
}

// ───────────── kinked rate model ─────────────

/// U = borrowed / supplied, WAD, rounded down (0 when nothing is supplied).
pub fn utilization(borrowed: u128, supplied: u128) -> Result<u128> {
    if supplied == 0 {
        return Ok(0);
    }
    mul_div(borrowed, WAD, supplied)
}

/// r(U) = r0 + s1·U/U* (U ≤ U*), r0 + s1 + s2·(U − U*)/(1 − U*) above. WAD per year, rounded down.
pub fn kinked_rate(u: u128, r0: u128, s1: u128, s2: u128, u_kink: u128) -> Result<u128> {
    if u <= u_kink {
        return Ok(r0 + mul_div(s1, u, u_kink)?);
    }
    Ok(r0 + s1 + mul_div(s2, u - u_kink, WAD - u_kink)?)
}

/// I = B × r × dt / YEAR, rounded up (twice).
pub fn interest(borrowed: u128, r: u128, dt: u128) -> Result<u128> {
    mul_div_up(mul_div_up(borrowed, r, WAD)?, dt, YEAR_SECS)
}

// ───────────── exponential and the GDA (F-4.5e) ─────────────

/// ln 2 in WAD.
const LN2_WAD: i128 = 693_147_180_559_945_309;

/// e^x for x in WAD, as WAD (rounded down). x below −41 gives 0; x above 40 is an overflow. Range reduction
/// x = n·ln2 + r with |r| ≤ ln2/2, e^r by its Taylor series (to below 1 part in 1e18), then × 2^n.
pub fn exp_wad(x: i128) -> Result<u128> {
    if x < -41 * WAD as i128 {
        return Ok(0);
    }
    require!(x <= 40 * WAD as i128, FinityError::MathOverflow);
    // n = round(x / ln2)
    let n = if x >= 0 { (x + LN2_WAD / 2) / LN2_WAD } else { (x - LN2_WAD / 2) / LN2_WAD };
    let r = x - n * LN2_WAD; // |r| ≤ ln2/2
    // Σ r^i / i! in WAD (signed); 20 terms is ample for |r| < 0.35.
    let mut term: i128 = WAD as i128;
    let mut sum: i128 = WAD as i128;
    for i in 1..=20i128 {
        term = term * r / WAD as i128 / i;
        if term == 0 {
            break;
        }
        sum += term;
    }
    let e_r = sum as u128;
    Ok(if n >= 0 { e_r << n as u32 } else { e_r >> (-n) as u32 })
}

/// USDC cost of the next `q` units of a continuous GDA (F-4.5e), before the floor:
///
///   cost = k · (r / λ) · e^(−λ (t − s / r)) · (e^(λ q / r) − 1) / 10^dec
///
/// where unit u becomes available at start + u / r and its price decays from k at rate λ. `k` is USDC base units
/// per whole token, `q`, `s` (sold) and `r` are token base units (per second), `t` seconds since the start and λ
/// is WAD per second. Rounded up (against the buyer).
pub fn gda_cost(k: u64, decay: u64, r: u64, sold: u64, q: u64, t: i64, dec: u8) -> Result<u64> {
    require!(r > 0 && decay > 0, FinityError::MathOverflow);
    if q == 0 {
        return Ok(0);
    }
    let (lam, r128) = (decay as i128, r as i128);
    // age of the next unit in WAD seconds: t − s / r
    let age = (t as i128) * WAD as i128 - (sold as i128) * WAD as i128 / r128;
    let a = -(lam * age / WAD as i128);
    let b = lam * (q as i128) / r128; // WAD
    let e_a = exp_wad(a)?;
    let e_b1 = exp_wad(b)? - WAD;
    // k · r / λ / 10^dec carried with 9 extra decimals (GDA_P), × e^a × (e^b − 1) (WAD factors), / GDA_P last.
    // Headroom: k · r up to ~1e22 (a $10k token emitted at 1e12 base units a second) stays inside u128.
    const GDA_P: u128 = 1_000_000_000;
    let base = mul_div_up(k as u128 * r as u128, WAD * GDA_P, decay as u128 * 10u128.pow(dec as u32))?;
    let c = mul_div_up(mul_div_up(base, e_a, WAD)?, e_b1, WAD)?;
    to_u64(mul_div_up(c, 1, GDA_P)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exp_matches_float() {
        for &x in &[-40.0f64, -10.5, -1.0, -0.3, 0.0, 0.2, 1.0, 2.5, 10.0, 30.0] {
            let got = exp_wad((x * 1e18) as i128).unwrap() as f64;
            let want = x.exp() * 1e18;
            // within 1e-12 relative, or one unit of WAD resolution for tiny values
            assert!((got - want).abs() <= (want * 1e-12).max(1.0), "e^{x}: {got} vs {want}");
        }
        assert_eq!(exp_wad(0).unwrap(), WAD);
        assert_eq!(exp_wad(-42 * WAD as i128).unwrap(), 0);
        assert!(exp_wad(41 * WAD as i128).is_err());
    }

    #[test]
    fn gda_cost_matches_float() {
        // 10 tokens (9 decimals) over 3 days, k = $183.60, half-life 24 h.
        let (k, dec) = (183_600_000u64, 9u8);
        let r = 10_000_000_000u64 / (3 * 86_400);
        let lam = 8_022_536_812_036u64;
        for &(sold, q, t) in &[(0u64, 1_000_000_000u64, 0i64), (0, 1_000_000_000, 86_400), (2_000_000_000, 500_000_000, 172_800), (0, 10_000_000_000, 259_200)] {
            let got = gda_cost(k, lam, r, sold, q, t, dec).unwrap() as f64;
            let (kf, rf, lf) = (k as f64, r as f64, lam as f64 / 1e18);
            let want = kf * (rf / lf) * (-lf * (t as f64 - sold as f64 / rf)).exp() * ((lf * q as f64 / rf).exp() - 1.0) / 1e9;
            assert!((got - want).abs() <= want * 1e-9 + 1.0, "sold {sold} q {q} t {t}: {got} vs {want}");
        }
        // One token at the start costs more than k: most of it is bought ahead of its emission time.
        let one = gda_cost(k, lam, r, 0, 1_000_000_000, 0, dec).unwrap();
        assert!(one > k);
        // A large inventory: 1M tokens of a $5,000 stock does not overflow.
        let big_r = 1_000_000_000_000_000u64 / (3 * 86_400);
        assert!(gda_cost(5_000_000_000, lam, big_r, 0, 1_000_000_000_000, 3_600, dec).is_ok());
        // A day later the same token costs about half.
        let later = gda_cost(k, lam, r, 0, 1_000_000_000, 86_400, dec).unwrap();
        assert!((later as f64 / one as f64 - 0.5).abs() < 1e-6);
    }

    #[test]
    fn rate_curve_kinks() {
        let (r0, s1, s2, k) = (WAD / 50, WAD * 6 / 100, WAD * 8 / 10, WAD * 9 / 10);
        assert_eq!(kinked_rate(0, r0, s1, s2, k).unwrap(), r0);
        assert_eq!(kinked_rate(k, r0, s1, s2, k).unwrap(), r0 + s1); // 8% at the kink
        assert_eq!(kinked_rate(WAD, r0, s1, s2, k).unwrap(), r0 + s1 + s2); // 88% at 100%
    }

    #[test]
    fn interest_rounds_up() {
        // 1,000 USDC at 10% for one second is 3.17 µUSDC → 4 base units.
        assert_eq!(interest(1_000_000_000, WAD / 10, 1).unwrap(), 4);
        assert_eq!(interest(1_000_000_000, WAD / 10, YEAR_SECS).unwrap(), 100_000_000);
    }

    #[test]
    fn share_rounding_directions() {
        let (a, s) = (1_000_003u128, 1_000_000_000_000u128);
        let up = to_assets_up(1, a, s, VIRTUAL_SHARES, VIRTUAL_ASSETS).unwrap();
        let down = to_assets_down(1, a, s, VIRTUAL_SHARES, VIRTUAL_ASSETS).unwrap();
        assert_eq!((down, up), (0, 1));
        assert!(to_shares_up(7, a, s, VIRTUAL_SHARES, VIRTUAL_ASSETS).unwrap() >= to_shares_down(7, a, s, VIRTUAL_SHARES, VIRTUAL_ASSETS).unwrap());
    }
}

