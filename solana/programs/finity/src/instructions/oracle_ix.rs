//! Signed prices (FinityPriceFeed + OracleAdapter, P7) and the guardian (FinityGuardian).
//!
//! Relayer nodes sign "FNTY" ‖ market ‖ price ‖ observed_at with Ed25519. The signatures travel as Ed25519
//! precompile instructions in the same transaction; `submit_prices` reads them through the instructions sysvar
//! and accepts a market's price only with k distinct authorised signers whose reports are fresh and newer than
//! the stored one. The stored price is the median, its time the oldest of the reports.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;

use crate::{constants::*, error::FinityError, state::*};

const ED25519_PROGRAM: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
/// Ed25519 instruction layout: [count u8, pad u8] then `count` × 14-byte offset records.
const SIG_RECORD: usize = 14;
const PUBKEY_LEN: usize = 32;
const SIG_LEN: usize = 64;

/// One signed report found in the transaction: (signer, market, price, observed_at).
type Report = (Pubkey, Pubkey, u64, i64);

/// Every report carried by the transaction's Ed25519 instructions. Only signatures whose key, signature and
/// message all live inside that same Ed25519 instruction count (index u16::MAX), so a report can't borrow its
/// bytes from another instruction.
fn signed_reports(ix_sysvar: &AccountInfo) -> Result<Vec<Report>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Ok(ix) = load_instruction_at_checked(i, ix_sysvar) {
        i += 1;
        if ix.program_id != ED25519_PROGRAM || ix.data.len() < 2 {
            continue;
        }
        let d = &ix.data;
        let count = d[0] as usize;
        for k in 0..count {
            let r = 2 + k * SIG_RECORD;
            if d.len() < r + SIG_RECORD {
                break;
            }
            let u16_at = |o: usize| u16::from_le_bytes([d[r + o], d[r + o + 1]]);
            let (sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) = (u16_at(2), u16_at(4) as usize, u16_at(6), u16_at(8) as usize, u16_at(10) as usize, u16_at(12));
            if sig_ix != u16::MAX || pk_ix != u16::MAX || msg_ix != u16::MAX || msg_len != REPORT_LEN {
                continue;
            }
            if d.len() < pk_off + PUBKEY_LEN || d.len() < msg_off + REPORT_LEN || u16_at(0) as usize + SIG_LEN > d.len() {
                continue;
            }
            let m = &d[msg_off..msg_off + REPORT_LEN];
            if &m[0..4] != REPORT_DOMAIN {
                continue;
            }
            let signer = Pubkey::new_from_array(d[pk_off..pk_off + PUBKEY_LEN].try_into().unwrap());
            let market = Pubkey::new_from_array(m[4..36].try_into().unwrap());
            let price = u64::from_le_bytes(m[36..44].try_into().unwrap());
            let at = i64::from_le_bytes(m[44..52].try_into().unwrap());
            out.push((signer, market, price, at));
        }
    }
    Ok(out)
}

// ---------- oracle setup ----------

#[derive(Accounts)]
pub struct SetOracle<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init_if_needed, payer = admin, space = 8 + OracleConfig::INIT_SPACE, seeds = [ORACLE_SEED], bump)]
    pub oracle: Box<Account<'info, OracleConfig>>,
    pub system_program: Program<'info, System>,
}

/// Admin: the signer set (1..=8 distinct keys), the threshold k, and whether direct keeper pushes stay allowed.
pub fn handle_set_oracle(ctx: Context<SetOracle>, signers: Vec<Pubkey>, threshold: u8, keeper_price_allowed: bool) -> Result<()> {
    require!(
        !signers.is_empty() && signers.len() <= MAX_ORACLE_SIGNERS && threshold >= 1 && threshold as usize <= signers.len(),
        FinityError::InvalidSigners
    );
    for (i, s) in signers.iter().enumerate() {
        require!(!signers[..i].contains(s), FinityError::InvalidSigners);
    }
    let o = &mut ctx.accounts.oracle;
    o.signers = signers;
    o.threshold = threshold;
    if o.max_delay_secs == 0 {
        o.max_delay_secs = DEFAULT_MAX_DELAY_SECS;
        o.max_ahead_secs = DEFAULT_MAX_AHEAD_SECS;
    }
    o.keeper_price_allowed = keeper_price_allowed;
    o.bump = ctx.bumps.oracle;
    Ok(())
}

// ---------- submit signed prices (permissionless) ----------

#[derive(Accounts)]
pub struct SubmitPrices<'info> {
    #[account(seeds = [ORACLE_SEED], bump = oracle.bump)]
    pub oracle: Box<Account<'info, OracleConfig>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: the instructions sysvar (address-checked by `load_instruction_at_checked`).
    pub instructions: UncheckedAccount<'info>,
}

/// Anyone may submit; only the signatures matter.
pub fn handle_submit_prices(ctx: Context<SubmitPrices>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.oracle;
    let market_key = ctx.accounts.market.key();
    let reports = signed_reports(&ctx.accounts.instructions)?;
    let mut seen: Vec<Pubkey> = Vec::new();
    let mut prices: Vec<u64> = Vec::new();
    let mut oldest = i64::MAX;
    for (signer, market, price, at) in reports {
        if market != market_key || !o.signers.contains(&signer) || seen.contains(&signer) || price == 0 {
            continue;
        }
        require!(at >= now - o.max_delay_secs && at <= now + o.max_ahead_secs, FinityError::ReportOutOfWindow);
        seen.push(signer);
        prices.push(price);
        oldest = oldest.min(at);
    }
    require!(prices.len() >= o.threshold as usize, FinityError::NotEnoughSignatures);
    let m = &mut ctx.accounts.market;
    require!(oldest > m.price_updated_at, FinityError::ReportOutOfWindow);
    prices.sort_unstable();
    m.price = prices[(prices.len() - 1) / 2]; // the lower median
    m.price_updated_at = oldest;
    Ok(())
}

// ---------- guardian ----------

#[derive(Accounts)]
pub struct InitGuardian<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init_if_needed, payer = admin, space = 8 + GuardianState::INIT_SPACE, seeds = [GUARDIAN_SEED], bump)]
    pub guardian_state: Box<Account<'info, GuardianState>>,
    pub system_program: Program<'info, System>,
}

/// Admin: names the guardian key (e.g. a Squads multisig vault).
pub fn handle_set_guardian(ctx: Context<InitGuardian>, guardian: Pubkey) -> Result<()> {
    let g = &mut ctx.accounts.guardian_state;
    g.guardian = guardian;
    g.bump = ctx.bumps.guardian_state;
    Ok(())
}

#[derive(Accounts)]
pub struct GuardianAct<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, seeds = [GUARDIAN_SEED], bump = guardian_state.bump,
        constraint = authority.key() == guardian_state.guardian || authority.key() == config.admin @ FinityError::NotGuardian,
    )]
    pub guardian_state: Box<Account<'info, GuardianState>>,
}

pub fn handle_guardian_pause(ctx: Context<GuardianAct>, borrow_paused: bool, cover_paused: bool) -> Result<()> {
    let g = &mut ctx.accounts.guardian_state;
    g.borrow_paused = borrow_paused;
    g.cover_paused = cover_paused;
    Ok(())
}

/// A temporary cut to every market's max LTV (and so its coverable LTV), at most 7 days.
pub fn handle_guardian_haircut(ctx: Context<GuardianAct>, haircut_bps: u16, until: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(haircut_bps < BPS as u16 && until <= now + MAX_HAIRCUT_SECS, FinityError::InvalidHaircut);
    let g = &mut ctx.accounts.guardian_state;
    g.haircut_bps = haircut_bps;
    g.haircut_until = until;
    Ok(())
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ FinityError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
}

/// Hands the admin role to another key (e.g. a Squads multisig vault).
pub fn handle_set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.admin = new_admin;
    Ok(())
}

/// The guardian state at its PDA, or the defaults (nothing paused, no haircut) before one is set. The account is
/// always passed at its fixed address, so a client can't dodge the guardian by leaving it out.
pub fn guardian_of(ai: &AccountInfo) -> Result<GuardianState> {
    let (pk, _) = Pubkey::find_program_address(&[GUARDIAN_SEED], &crate::ID);
    require_keys_eq!(*ai.key, pk, FinityError::NotGuardian);
    if ai.data_is_empty() {
        return Ok(GuardianState { guardian: Pubkey::default(), borrow_paused: false, cover_paused: false, haircut_bps: 0, haircut_until: 0, bump: 0 });
    }
    require_keys_eq!(*ai.owner, crate::ID, FinityError::NotGuardian);
    GuardianState::try_deserialize(&mut &ai.try_borrow_data()?[..])
}

/// Direct price pushes are allowed only before an oracle is configured or when the admin left them on.
pub fn keeper_price_allowed(ai: &AccountInfo) -> Result<bool> {
    let (pk, _) = Pubkey::find_program_address(&[ORACLE_SEED], &crate::ID);
    require_keys_eq!(*ai.key, pk, FinityError::KeeperPriceDisabled);
    if ai.data_is_empty() {
        return Ok(true);
    }
    require_keys_eq!(*ai.owner, crate::ID, FinityError::KeeperPriceDisabled);
    Ok(OracleConfig::try_deserialize(&mut &ai.try_borrow_data()?[..])?.keeper_price_allowed)
}
