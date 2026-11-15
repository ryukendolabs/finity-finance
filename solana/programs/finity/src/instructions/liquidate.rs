//! The loss waterfall (§8.4.3 `_waterfall`). Liquidations themselves run through auctions (auction_ix.rs).

use anchor_lang::prelude::*;

use crate::state::*;

/// Bad debt d leaves the market's books, and the cash it was owed comes from the underwriter pool first, then the
/// protocol reserve; whatever is left is a loss to the senior vault's supply (its share price falls).
pub fn write_off(
    market: &mut Market,
    position: &mut Position,
    senior: &mut SeniorVault,
    pool: &mut UnderwriterPool,
    reserve: &mut ProtocolReserve,
) -> Result<u64> {
    let shares = position.borrow_shares;
    let d = market.debt_of(shares)?;
    market.total_borrow_assets = market.total_borrow_assets.saturating_sub(d);
    market.total_borrow_shares -= shares;
    position.borrow_shares = 0;

    let from_pool = d.min(pool.free_cash());
    pool.cash -= from_pool;
    pool.losses_paid += from_pool;
    let rest = d - from_pool;
    let from_reserve = rest.min(reserve.cash);
    reserve.cash -= from_reserve;
    reserve.losses_paid += from_reserve;
    let senior_loss = (rest - from_reserve).min(market.total_supply_assets);
    market.total_supply_assets -= senior_loss;
    senior.total_supplied = senior.total_supplied.saturating_sub(senior_loss);
    msg!("write-off {}: pool {}, reserve {}, senior {}", d, from_pool, from_reserve, senior_loss);
    Ok(d)
}
