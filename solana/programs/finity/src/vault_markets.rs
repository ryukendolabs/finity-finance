//! The senior vault's markets, passed as remaining accounts in `SeniorVault.markets` order. Loading accrues each
//! one first, so `total_assets` is exact (SeniorVault.totalAssets = idle + Σ supplied).

use anchor_lang::prelude::*;

use crate::{error::FinityError, state::*};

pub fn load<'info>(vault: &mut SeniorVault, ais: &'info [AccountInfo<'info>], now: i64) -> Result<Vec<Account<'info, Market>>> {
    require!(ais.len() >= vault.markets.len(), FinityError::WrongMarketAccounts);
    let mut out = Vec::with_capacity(vault.markets.len());
    for (i, key) in vault.markets.clone().iter().enumerate() {
        let ai = &ais[i];
        require_keys_eq!(*ai.key, *key, FinityError::WrongMarketAccounts);
        require!(ai.is_writable, FinityError::WrongMarketAccounts);
        let mut m = Account::<Market>::try_from(ai)?;
        let senior = m.accrue(now)?;
        vault.total_supplied = vault.total_supplied.checked_add(senior).ok_or(FinityError::MathOverflow)?;
        out.push(m);
    }
    Ok(out)
}

pub fn save(markets: &[Account<Market>]) -> Result<()> {
    for m in markets {
        m.exit(&crate::ID)?;
    }
    Ok(())
}

/// What can be paid out now: idle plus each withdraw-queue market's min(liquidity, supplied).
pub fn available(vault: &SeniorVault, markets: &[Account<Market>]) -> u64 {
    vault.withdraw_queue.iter().fold(vault.idle, |a, &i| {
        let m = &markets[i as usize];
        a.saturating_add(m.liquidity().min(m.total_supply_assets))
    })
}

/// Supplies `assets` of idle cash down the supply queue, up to each market's vault cap and supply cap (_supplyDown).
pub fn supply_down(vault: &mut SeniorVault, markets: &mut [Account<Market>], mut assets: u64) {
    for &i in vault.supply_queue.clone().iter() {
        if assets == 0 {
            break;
        }
        let m = &mut markets[i as usize];
        let supplied = m.total_supply_assets;
        let room = vault.caps[i as usize].saturating_sub(supplied).min(m.supply_cap.saturating_sub(supplied));
        let amt = room.min(assets);
        if amt == 0 {
            continue;
        }
        m.total_supply_assets += amt;
        vault.idle -= amt;
        vault.total_supplied += amt;
        assets -= amt;
    }
}

/// Brings idle up to `assets`, withdrawing supply down the withdraw queue (_pull).
pub fn pull(vault: &mut SeniorVault, markets: &mut [Account<Market>], assets: u64) -> Result<()> {
    if vault.idle >= assets {
        return Ok(());
    }
    let mut need = assets - vault.idle;
    for &i in vault.withdraw_queue.clone().iter() {
        if need == 0 {
            break;
        }
        let m = &mut markets[i as usize];
        let amt = m.liquidity().min(m.total_supply_assets).min(need);
        if amt == 0 {
            continue;
        }
        m.total_supply_assets -= amt;
        vault.total_supplied -= amt;
        vault.idle += amt;
        need -= amt;
    }
    require!(need == 0, FinityError::VaultIlliquid);
    Ok(())
}
