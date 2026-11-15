//! Uniform-price batch auctions for every liquidation (§8.7): loans join a
//! lot (flag), each position's share is sized at the lot-fix deadline (F-4.5a/b), bids clear at one price with
//! pro-rata ties (F-4.5c), the pool buys what bidders don't at the reserve, and each loan settles from the
//! proceeds (F-4.5d) with the penalty split and any shortfall through the waterfall. Arrival order never matters
//! (P5). Kinds: INTRADAY (regular session), EMERGENCY (extended hours, never a covered loan), REOPEN (sealed, at
//! the open print), PRECLOSE (before the close). The pool's backstop purchases become inventory (inventory_ix.rs):
//! resold by GDA, or for the T-Bill fund redeemed with the fund (§8.8, κ_nav reserve).

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

use crate::{
    clock as clk,
    constants::*,
    error::FinityError,
    instructions::{cover_ix::coverable_ltv, liquidate::write_off, user::accrue},
    math::*,
    risk,
    state::*,
};

/// κ of a lot, WAD: the pre-close batch's own (R-06), κ_nav for a T-Bill fund lot (§8.8), else the engine's.
pub fn kappa_of(kind: u8, nav: bool, cfg: &RiskConfig) -> u128 {
    if kind == KIND_PRECLOSE {
        KAPPA_PRE_BPS as u128 * WAD / BPS as u128
    } else if nav {
        KAPPA_NAV_BPS as u128 * WAD / BPS as u128
    } else {
        cfg.kappa as u128
    }
}

/// R = (1 − κ) × base, in USDC base units per token.
fn reserve_of(base_price: u64, kappa_wad: u128) -> Result<u64> {
    to_u64(mul_div(base_price as u128, WAD - kappa_wad, WAD)?)
}

/// Lot value in USDC base units: q × price / 10^decimals.
fn usd(q: u64, price: u64, dec: u8) -> Result<u64> {
    to_u64(mul_div(q as u128, price as u128, 10u128.pow(dec as u32))?)
}

pub fn commitment(auction: &Pubkey, bidder: &Pubkey, qty: u64, price: u64, salt: &[u8; 32]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[b"finity-bid", auction.as_ref(), bidder.as_ref(), &qty.to_le_bytes(), &price.to_le_bytes(), salt]).to_bytes()
}

pub fn tie_key(auction: &Pubkey, bidder: &Pubkey) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[auction.as_ref(), bidder.as_ref()]).to_bytes()
}

// ---------- flag: a loan joins (or opens) the auction of its kind ----------

#[derive(Accounts)]
#[instruction(kind: u8, auction_id: u64)]
pub struct Flag<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()], bump = position.bump, has_one = market)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    /// The upcoming closure's risk set (PRECLOSE target LTV); any of the market's sets otherwise.
    #[account(seeds = [RISK_SET_SEED, market.key().as_ref(), &[risk_set.closure_type]], bump = risk_set.bump, has_one = market)]
    pub risk_set: Box<Account<'info, RiskSet>>,
    /// The loan's Gap Cover for the upcoming closure; must not exist for a pre-close sale.
    /// CHECK: only its emptiness is read, at the policy PDA checked below.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: the loan's auto-cover opt-out marker PDA; only its existence is read.
    #[account(seeds = [NO_AUTOCOVER_SEED, position.key().as_ref()], bump)]
    pub opt_out: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = cranker, space = 8 + AuctionBook::INIT_SPACE,
        seeds = [AUCTION_BOOK_SEED, market.key().as_ref()], bump,
    )]
    pub book: Box<Account<'info, AuctionBook>>,
    #[account(
        init_if_needed, payer = cranker, space = 8 + Auction::INIT_SPACE,
        seeds = [AUCTION_SEED, market.key().as_ref(), &auction_id.to_le_bytes()], bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init, payer = cranker, space = 8 + LotEntry::INIT_SPACE,
        seeds = [LOT_ENTRY_SEED, auction.key().as_ref(), position.owner.as_ref()], bump,
    )]
    pub entry: Box<Account<'info, LotEntry>>,
    #[account(
        init_if_needed, payer = cranker, space = 8 + PositionLock::INIT_SPACE,
        seeds = [LOCK_SEED, position.key().as_ref()], bump,
    )]
    pub lock: Box<Account<'info, PositionLock>>,
    pub system_program: Program<'info, System>,
}

/// Permissionless. INTRADAY: health below 1 in the regular session. EMERGENCY: health below 1 in extended hours,
/// unless the loan holds Gap Cover for the closure in progress (INV-LIQ-02; `policy` = that policy's PDA). REOPEN: health below 1 at the open print,
/// during the reopen queue window. PRECLOSE: after the Bell deadline, a loan above its safe LTV that can't be
/// covered (above the coverable LTV) is sold down to the safe LTV before the close.
pub fn handle_flag(mut ctx: Context<Flag>, kind: u8, auction_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    require!(a.lock.auction == Pubkey::default(), FinityError::WrongAuctionPhase);
    let state = clk::poke(&mut a.clock, a.calendar.load()?.live(), &mut a.market, now)?;
    accrue(&mut a.market, &mut a.senior)?;
    let m = &a.market;
    let debt = m.debt_of(a.position.borrow_shares)?;
    require!(debt > 0 && a.position.collateral > 0, FinityError::NotLiquidatable);
    let lt = m.liq_threshold_bps as u16;
    let nav = a.calendar.load()?.venue == VENUE_USBANK;

    let book = &mut a.book;
    if book.market == Pubkey::default() {
        book.market = m.key();
        book.bump = ctx.bumps.book;
    }
    // The joinable auction of this kind, or a new one with the next id.
    let (joinable, closure, start, offsets, target_ltv) = match kind {
        KIND_INTRADAY => {
            require!(state == ClockState::Regular, FinityError::MarketNotOpen);
            require!(debt as u128 > m.limit(a.position.collateral, lt)?, FinityError::NotLiquidatable);
            (book.intraday, 0u64, now, TIMINGS_INTRADAY, 0u64)
        }
        KIND_EMERGENCY => {
            require!(state == ClockState::Extended, FinityError::WrongAuctionPhase);
            require!(debt as u128 > m.limit(a.position.collateral, lt)?, FinityError::NotLiquidatable);
            let (pk, _) = Pubkey::find_program_address(
                &[POLICY_SEED, m.key().as_ref(), a.position.owner.as_ref(), &a.clock.closure_id.to_le_bytes()],
                &crate::ID,
            );
            require_keys_eq!(a.policy.key(), pk, FinityError::WrongRiskSet);
            require!(a.policy.data_is_empty(), FinityError::NotLiquidatable); // covered: never sold in EXTENDED
            // Shares the book's intraday slot: the two kinds run in different clock states.
            (book.intraday, a.clock.closure_id, now, TIMINGS_EMERGENCY, 0u64)
        }
        KIND_REOPEN => {
            require!(state == ClockState::Reopen && a.clock.open_print > 0, FinityError::WrongAuctionPhase);
            let v = m.collateral_value_at(a.position.collateral, a.clock.open_print)?;
            require!(debt as u128 > v * lt as u128 / BPS as u128, FinityError::NotLiquidatable);
            let j = if book.reopen_closure == a.clock.closure_id { book.reopen } else { 0 };
            (j, a.clock.closure_id, a.clock.open_print_at, TIMINGS_REOPEN, 0)
        }
        KIND_PRECLOSE => {
            require!(state == ClockState::Regular && now >= a.clock.bell_at, FinityError::CoverWindowClosed);
            require!(a.risk_set.closure_type == a.clock.next_closure_type, FinityError::WrongRiskSet);
            let upcoming = a.clock.closure_id + 1;
            let (pk, _) = Pubkey::find_program_address(
                &[POLICY_SEED, m.key().as_ref(), a.position.owner.as_ref(), &upcoming.to_le_bytes()],
                &crate::ID,
            );
            require_keys_eq!(a.policy.key(), pk, FinityError::WrongRiskSet);
            require!(a.policy.data_is_empty(), FinityError::BellNotNeeded);
            let c = m.collateral_value(a.position.collateral)?;
            let days = clk::closure_days(a.clock.next_close_at, a.clock.next_reopen_at)?;
            let d_proj = risk::projected_debt(debt as u128, m.borrow_rate()?, days)?;
            let safe = clk::safe_ltv_wad(m, &a.risk_config, &a.risk_set)?;
            let (status, _, _) = risk::bell_status(c, d_proj, safe, false)?;
            require!(status == risk::BELL_NEEDS_ACTION, FinityError::BellNotNeeded);
            // Coverable loans are auto-covered by the Bell, unless their borrower switched that off.
            require!(risk::ltv_up(debt as u128, c)? > coverable_ltv(m) || !a.opt_out.data_is_empty(), FinityError::BellNotNeeded);
            let j = if book.preclose_closure == upcoming { book.preclose } else { 0 };
            (j, upcoming, a.clock.next_close_at, TIMINGS_PRECLOSE, to_u64(safe)?)
        }
        _ => return err!(FinityError::WrongAuctionPhase),
    };

    let auction = &mut a.auction;
    if joinable != 0 && auction.id == joinable && auction.kind == kind && auction.phase == PHASE_QUEUE && now < auction.deadlines[0] {
        require!(auction_id == joinable, FinityError::WrongAuctionPhase);
    } else {
        // A new auction: it must be the book's next id and not exist yet.
        require!(auction_id == book.next_id + 1 && auction.phase == 0, FinityError::WrongAuctionPhase);
        book.next_id += 1;
        auction.market = m.key();
        auction.id = auction_id;
        auction.kind = kind;
        auction.phase = PHASE_QUEUE;
        auction.closure_id = closure;
        auction.deadlines = if kind == KIND_PRECLOSE {
            [start - offsets[0], start - offsets[1], start - offsets[2], start - offsets[3]]
        } else {
            [start + offsets[0], start + offsets[1], start + offsets[2], start + offsets[3]]
        };
        auction.nav = nav;
        let kappa = kappa_of(kind, nav, &a.risk_config);
        auction.start_price = if kind == KIND_REOPEN { a.clock.open_print } else { m.price };
        auction.reserve = reserve_of(auction.start_price, kappa)?;
        auction.bump = ctx.bumps.auction;
        match kind {
            KIND_INTRADAY | KIND_EMERGENCY => book.intraday = auction_id,
            KIND_REOPEN => {
                book.reopen = auction_id;
                book.reopen_closure = closure;
            }
            _ => {
                book.preclose = auction_id;
                book.preclose_closure = closure;
            }
        }
        require!(now < auction.deadlines[0], FinityError::WrongAuctionPhase);
    }
    require!(auction.positions < MAX_LOT_POSITIONS, FinityError::AuctionFull);
    auction.positions += 1;

    let e = &mut a.entry;
    e.auction = auction.key();
    e.owner = a.position.owner;
    e.target_ltv = target_ltv;
    e.bump = ctx.bumps.entry;
    a.lock.position = a.position.key();
    a.lock.auction = auction.key();
    a.lock.bump = ctx.bumps.lock;
    Ok(())
}

// ---------- fix: size one position's share of the lot ----------

#[derive(Accounts)]
pub struct FixPosition<'info> {
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()], bump = position.bump, has_one = market)]
    pub position: Box<Account<'info, Position>>,
    #[account(seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market)]
    pub clock: Box<Account<'info, AssetClock>>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    #[account(mut, seeds = [AUCTION_SEED, market.key().as_ref(), &auction.id.to_le_bytes()], bump = auction.bump, has_one = market)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [LOT_ENTRY_SEED, auction.key().as_ref(), position.owner.as_ref()], bump = entry.bump, has_one = auction)]
    pub entry: Box<Account<'info, LotEntry>>,
}

/// Permissionless, from the lot-fix deadline until bidding ends: x = F-4.5a (REOPEN / INTRADAY, to H* = 1.10 at
/// the reserve, health at the open print or live price) or F-4.5b (PRECLOSE, down to the safe LTV at R_pre).
/// A loan that cured since it was flagged sells nothing.
pub fn handle_fix_position(mut ctx: Context<FixPosition>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    let au = &a.auction;
    require!(au.phase == PHASE_QUEUE || au.phase == PHASE_BIDDING, FinityError::WrongAuctionPhase);
    require!(now >= au.deadlines[0] && now < au.deadlines[2], FinityError::WrongAuctionPhase);
    require!(!a.entry.fixed, FinityError::WrongAuctionPhase);
    accrue(&mut a.market, &mut a.senior)?;
    let m = &a.market;
    let debt = m.debt_of(a.position.borrow_shares)? as u128;
    let q = a.position.collateral as u128;
    let dec = m.collateral_decimals;
    let x = if au.kind == KIND_PRECLOSE {
        let v = risk::price_wad(m.price);
        let r_pre = risk::price_wad(reserve_of(m.price, kappa_of(KIND_PRECLOSE, au.nav, &a.risk_config))?);
        let days = clk::closure_days(a.clock.next_close_at, a.clock.next_reopen_at).unwrap_or(4);
        let d_proj = risk::projected_debt(debt, m.borrow_rate()?, days)?;
        let lam = LAMBDA_PRE_BPS as u128 * WAD / BPS as u128;
        risk::preclose_lot(d_proj, q, v, r_pre, a.entry.target_ltv as u128, lam, dec)?
    } else {
        let hf_price = if au.kind == KIND_REOPEN { a.clock.open_print } else { m.price };
        let lt = m.liq_threshold_bps as u128 * WAD / BPS as u128;
        let lam = m.liq_bonus_bps as u128 * WAD / BPS as u128;
        risk::liquidation_lot(debt, q, risk::price_wad(au.reserve), risk::price_wad(hf_price), lt, H_STAR_WAD, lam, dec)?
    } as u64;

    let e = &mut a.entry;
    e.fixed = true;
    e.qty = x;
    e.qty_before = q as u64;
    a.position.collateral -= x;
    a.market.total_collateral -= x;
    let au = &mut a.auction;
    au.lot += x;
    au.fixed += 1;
    if au.kind == KIND_PRECLOSE && au.fixed == 1 {
        au.start_price = a.market.price; // V_fix
    }
    if au.phase == PHASE_QUEUE {
        au.phase = PHASE_BIDDING;
    }
    Ok(())
}

// ---------- bids ----------

#[derive(Accounts)]
pub struct PlaceBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [AUCTION_SEED, market.key().as_ref(), &auction.id.to_le_bytes()], bump = auction.bump, has_one = market)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init_if_needed, payer = bidder, space = 8 + Bid::INIT_SPACE,
        seeds = [BID_SEED, auction.key().as_ref(), bidder.key().as_ref()], bump,
    )]
    pub bid: Box<Account<'info, Bid>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = bidder)]
    pub bidder_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

fn escrow_in<'info>(a: &PlaceBid<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new(
            a.token_program.key(),
            Transfer { from: a.bidder_usdc.to_account_info(), to: a.usdc_vault.to_account_info(), authority: a.bidder.to_account_info() },
        ),
        amount,
    )
}

fn new_bid(a: &mut PlaceBid, bump: u8) -> Result<()> {
    require!(a.bid.bidder == Pubkey::default(), FinityError::WrongAuctionPhase); // one bid per bidder
    require!(a.auction.bid_count < MAX_BIDS, FinityError::AuctionFull);
    a.auction.bid_count += 1;
    a.bid.auction = a.auction.key();
    a.bid.bidder = a.bidder.key();
    a.bid.bump = bump;
    Ok(())
}

/// INTRADAY / PRECLOSE: a firm bid at or above the reserve, escrowing qty × price.
pub fn handle_place_bid(mut ctx: Context<PlaceBid>, qty: u64, price: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.bid;
    let a = &mut ctx.accounts;
    let au = &a.auction;
    require!(au.kind != KIND_REOPEN, FinityError::WrongAuctionPhase);
    require!(now >= au.deadlines[1] && now < au.deadlines[2] && au.phase != PHASE_CLEARED, FinityError::WrongAuctionPhase);
    require!(qty > 0, FinityError::ZeroAmount);
    require!(price >= au.reserve, FinityError::BidBelowReserve);
    new_bid(a, bump)?;
    let notional = usd(qty, price, a.market.collateral_decimals)?;
    escrow_in(a, notional)?;
    let b = &mut a.bid;
    b.qty = qty;
    b.price = price;
    b.escrow = notional;
    b.revealed = true;
    a.auction.revealed += 1;
    Ok(())
}

/// REOPEN commit window: a sealed commitment sha256("finity-bid", auction, bidder, qty, price, salt) with a bond
/// of 10% of the declared maximum notional (R-04).
pub fn handle_commit_bid(mut ctx: Context<PlaceBid>, commitment: [u8; 32], max_notional: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.bid;
    let a = &mut ctx.accounts;
    let au = &a.auction;
    require!(au.kind == KIND_REOPEN && now >= au.deadlines[1] && now < au.deadlines[2], FinityError::WrongAuctionPhase);
    require!(max_notional > 0, FinityError::ZeroAmount);
    new_bid(a, bump)?;
    let bond = to_u64(mul_div(max_notional as u128, BOND_BPS as u128, BPS as u128)?)?;
    escrow_in(a, bond)?;
    let b = &mut a.bid;
    b.commitment = commitment;
    b.max_notional = max_notional;
    b.bond = bond;
    b.escrow = bond;
    Ok(())
}

/// REOPEN reveal window: opens the commitment and escrows the rest of qty × price (the bond counts toward it). A
/// bid below the reserve can't be revealed and forfeits its bond (QA-02).
pub fn handle_reveal_bid(mut ctx: Context<PlaceBid>, qty: u64, price: u64, salt: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let au = &a.auction;
    require!(au.kind == KIND_REOPEN && now >= au.deadlines[2] && now < au.deadlines[3], FinityError::WrongAuctionPhase);
    let b = &a.bid;
    require!(b.bidder == a.bidder.key() && !b.revealed, FinityError::WrongAuctionPhase);
    require!(commitment(&au.key(), &a.bidder.key(), qty, price, &salt) == b.commitment, FinityError::CommitmentMismatch);
    require!(price >= au.reserve && qty > 0, FinityError::BidBelowReserve);
    let notional = usd(qty, price, a.market.collateral_decimals)?;
    require!(notional <= b.max_notional, FinityError::NotionalAboveMax);
    let top_up = notional.saturating_sub(b.escrow);
    escrow_in(a, top_up)?;
    let a = &mut ctx.accounts;
    let b = &mut a.bid;
    b.qty = qty;
    b.price = price;
    b.escrow += top_up;
    b.revealed = true;
    a.auction.revealed += 1;
    if a.auction.phase == PHASE_BIDDING {
        a.auction.phase = PHASE_REVEAL;
    }
    Ok(())
}

// ---------- clear ----------

#[derive(Accounts)]
pub struct ClearAuction<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [RISK_CONFIG_SEED], bump = risk_config.bump)]
    pub risk_config: Box<Account<'info, RiskConfig>>,
    #[account(mut, seeds = [AUCTION_SEED, market.key().as_ref(), &auction.id.to_le_bytes()], bump = auction.bump, has_one = market)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// The pool's inventory of this collateral (backstop purchases).
    #[account(
        init_if_needed, payer = cranker,
        associated_token::mint = collateral_mint, associated_token::authority = pool, associated_token::token_program = token_program,
    )]
    pub inventory: Box<Account<'info, TokenAccount>>,
    /// The books of that inventory: quantity, cost and mark (F-4.5e).
    #[account(
        init_if_needed, payer = cranker, space = 8 + Inventory::INIT_SPACE,
        seeds = [INVENTORY_SEED, pool.key().as_ref(), collateral_mint.key().as_ref()], bump,
    )]
    pub inventory_state: Box<Account<'info, Inventory>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Remaining accounts: every bid of the auction (any order). At the clear deadline: R final (open kinds:
/// (1 − κ)·min(V_start, V_now)), uniform-price clearing over the revealed bids ≥ R, the pool buys the rest at R
/// (paying what its free cash allows), unrevealed bonds go to the pool. Tokens and change are claimed by bidders.
pub fn handle_clear_auction<'info>(mut ctx: Context<'info, ClearAuction<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    require!(a.auction.phase != PHASE_CLEARED && a.auction.phase != PHASE_CANCELLED, FinityError::WrongAuctionPhase);
    require!(now >= a.auction.deadlines[3], FinityError::WrongAuctionPhase);
    require!(a.pool.markets.contains(&a.market.key()), FinityError::WrongPool);
    let dec = a.market.collateral_decimals;
    if a.auction.kind != KIND_REOPEN {
        let k = kappa_of(a.auction.kind, a.auction.nav, &a.risk_config);
        a.auction.reserve = reserve_of(a.auction.start_price.min(a.market.price), k)?; // R-19
    }
    let (lot, reserve) = (a.auction.lot as u128, a.auction.reserve as u128);

    // Every bid, once.
    let n = a.auction.bid_count as usize;
    require!(ctx.remaining_accounts.len() == n, FinityError::WrongBidAccounts);
    let mut bids: Vec<Account<'info, Bid>> = Vec::with_capacity(n);
    for ai in ctx.remaining_accounts.iter() {
        let b = Account::<Bid>::try_from(ai)?;
        let (pk, _) = Pubkey::find_program_address(&[BID_SEED, a.auction.key().as_ref(), b.bidder.as_ref()], &crate::ID);
        require!(*ai.key == pk && ai.is_writable && !bids.iter().any(|x| x.key() == pk), FinityError::WrongBidAccounts);
        bids.push(b);
    }
    let qtys: Vec<u128> = bids.iter().map(|b| if b.revealed { b.qty as u128 } else { 0 }).collect();
    let prices: Vec<u128> = bids.iter().map(|b| if b.revealed { b.price as u128 } else { 0 }).collect();
    let keys: Vec<[u8; 32]> = bids.iter().map(|b| tie_key(&a.auction.key(), &b.bidder)).collect();
    let (p_star, fills, q_pool) = risk::clear(&qtys, &prices, &keys, lot, reserve)?;

    let mut paid = 0u64;
    let mut bonds = 0u64;
    for (i, b) in bids.iter_mut().enumerate() {
        b.fill = fills[i] as u64;
        if b.fill > 0 {
            let cost = usd(b.fill, p_star as u64, dec)?;
            b.escrow -= cost;
            paid += cost;
        }
        if !b.revealed && b.bond > 0 {
            b.escrow -= b.bond;
            bonds += b.bond;
        }
        b.exit(&crate::ID)?;
    }
    // The pool backstops the unfilled quantity at R, as far as its free cash allows; the tokens go to its inventory.
    let cost = usd(q_pool as u64, reserve as u64, dec)?;
    let pool_paid = cost.min(a.pool.free_cash());
    a.pool.cash -= pool_paid;
    a.pool.cash += bonds;
    if q_pool > 0 {
        let mint_key = a.market.collateral_mint;
        let seeds: &[&[u8]] = &[MARKET_SEED, mint_key.as_ref(), &[a.market.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.key(),
                Transfer { from: a.vault.to_account_info(), to: a.inventory.to_account_info(), authority: a.market.to_account_info() },
                &[seeds],
            ),
            q_pool as u64,
        )?;
    }
    let au = &mut a.auction;
    au.p_star = p_star as u64;
    au.q_pool = q_pool as u64;
    au.filled = (lot - q_pool) as u64;
    au.blended_price = to_u64(risk::blended_price(lot, p_star, q_pool, reserve)?)?;
    au.proceeds = paid + pool_paid;
    au.pool_paid = pool_paid;
    au.bonds_forfeited = bonds;
    au.phase = PHASE_CLEARED;
    let nav = au.nav;

    if q_pool > 0 {
        let inv = &mut a.inventory_state;
        if inv.pool == Pubkey::default() {
            inv.pool = a.pool.key();
            inv.market = a.market.key();
            inv.mint = a.market.collateral_mint;
            inv.nav = nav;
            inv.bump = ctx.bumps.inventory_state;
        }
        inv.qty += q_pool as u64;
        inv.cost += pool_paid;
        let kappa = kappa_of(KIND_INTRADAY, inv.nav, &a.risk_config);
        crate::instructions::inventory_ix::remark(inv, &mut a.pool, a.market.price, dec, kappa)?;
    }
    Ok(())
}

// ---------- settle each loan of the lot ----------

#[derive(Accounts)]
pub struct SettleLotPosition<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SENIOR_SEED], bump = senior.bump)]
    pub senior: Box<Account<'info, SeniorVault>>,
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()], bump = position.bump, has_one = market)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [AUCTION_SEED, market.key().as_ref(), &auction.id.to_le_bytes()], bump = auction.bump, has_one = market)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [LOT_ENTRY_SEED, auction.key().as_ref(), position.owner.as_ref()], bump = entry.bump, has_one = auction)]
    pub entry: Box<Account<'info, LotEntry>>,
    #[account(mut, seeds = [LOCK_SEED, position.key().as_ref()], bump = lock.bump)]
    pub lock: Box<Account<'info, PositionLock>>,
    #[account(mut, seeds = [POOL_SEED, &pool.venue], bump = pool.bump)]
    pub pool: Box<Account<'info, UnderwriterPool>>,
    #[account(mut, seeds = [RESERVE_SEED], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ProtocolReserve>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// The borrower's USDC (associated account, created by the cranker if needed), for a refund.
    #[account(
        init_if_needed, payer = cranker,
        associated_token::mint = usdc_mint, associated_token::authority = owner, associated_token::token_program = token_program,
    )]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: the position's owner (refund recipient).
    #[account(address = position.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Permissionless after clearing (F-4.5d): proceeds P = value(x, p̄); partial → penalty λP, debt − (1 − λ)P; full
/// and solvent → penalty min(λP, P − D), the rest refunded; full and short → shortfall through the waterfall
/// (pool, reserve, senior). Penalty: ⅓ to the pool, the rest to the protocol reserve. A loan that was flagged but
/// not fixed in time just leaves the lot.
pub fn handle_settle_lot_position(mut ctx: Context<SettleLotPosition>) -> Result<()> {
    let a = &mut ctx.accounts;
    require!(a.auction.phase == PHASE_CLEARED, FinityError::WrongAuctionPhase);
    require!(!a.entry.settled, FinityError::WrongAuctionPhase);
    a.entry.settled = true;
    a.lock.auction = Pubkey::default();
    a.auction.settled += 1;
    if !a.entry.fixed || a.entry.qty == 0 {
        return Ok(());
    }
    accrue(&mut a.market, &mut a.senior)?;
    let dec = a.market.collateral_decimals;
    let held = a.position.borrow_shares;
    let debt = a.market.debt_of(held)? as u128;
    let lam = if a.auction.kind == KIND_PRECLOSE { LAMBDA_PRE_BPS } else { a.market.liq_bonus_bps as u64 } as u128 * WAD / BPS as u128;
    let s = risk::settle_position(a.entry.qty as u128, a.entry.qty_before as u128, risk::price_wad(a.auction.blended_price), debt, lam, dec)?;
    // Never attribute more than the lot raised (the pool may have been short of cash for its part).
    let left = a.auction.proceeds as u128;
    let scale = if s.proceeds > left && s.proceeds > 0 { (left, s.proceeds) } else { (1, 1) };
    let cap = |v: u128| v * scale.0 / scale.1;
    let (repaid, penalty, refund) = (to_u64(cap(s.repaid))?, to_u64(cap(s.penalty))?, to_u64(cap(s.refund))?);
    a.auction.proceeds -= repaid + penalty + refund;

    let burned = a.market.remove_borrow(repaid, held)?;
    a.position.borrow_shares = held - burned;
    let to_pool = penalty / 3;
    a.pool.cash += to_pool;
    a.reserve.cash += penalty - to_pool;
    if refund > 0 {
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[a.config.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.key(),
                Transfer { from: a.usdc_vault.to_account_info(), to: a.owner_usdc.to_account_info(), authority: a.config.to_account_info() },
                &[seeds],
            ),
            refund,
        )?;
    }
    if s.full_close && a.position.collateral == 0 && a.position.borrow_shares > 0 {
        write_off(&mut a.market, &mut a.position, &mut a.senior, &mut a.pool, &mut a.reserve)?;
    }
    Ok(())
}

// ---------- bidders claim ----------

#[derive(Accounts)]
pub struct ClaimBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [AUCTION_SEED, market.key().as_ref(), &auction.id.to_le_bytes()], bump = auction.bump, has_one = market)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [BID_SEED, auction.key().as_ref(), bidder.key().as_ref()], bump = bid.bump, has_one = bidder, has_one = auction)]
    pub bid: Box<Account<'info, Bid>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = bidder,
        associated_token::mint = collateral_mint, associated_token::authority = bidder, associated_token::token_program = token_program,
    )]
    pub bidder_collateral: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = bidder,
        associated_token::mint = usdc_mint, associated_token::authority = bidder, associated_token::token_program = token_program,
    )]
    pub bidder_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump = config.usdc_vault_bump)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// After clearing: winners take their tokens; everyone takes the unused escrow back (a forfeited bond stays).
pub fn handle_claim_bid(ctx: Context<ClaimBid>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.auction.phase == PHASE_CLEARED && !a.bid.claimed, FinityError::WrongAuctionPhase);
    let (fill, change) = (a.bid.fill, a.bid.escrow);
    if fill > 0 {
        let mint_key = a.market.collateral_mint;
        let seeds: &[&[u8]] = &[MARKET_SEED, mint_key.as_ref(), &[a.market.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.key(),
                Transfer { from: a.vault.to_account_info(), to: a.bidder_collateral.to_account_info(), authority: a.market.to_account_info() },
                &[seeds],
            ),
            fill,
        )?;
    }
    if change > 0 {
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[a.config.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.key(),
                Transfer { from: a.usdc_vault.to_account_info(), to: a.bidder_usdc.to_account_info(), authority: a.config.to_account_info() },
                &[seeds],
            ),
            change,
        )?;
    }
    let b = &mut ctx.accounts.bid;
    b.claimed = true;
    b.escrow = 0;
    Ok(())
}

// ---------- end the reopen ----------

#[derive(Accounts)]
pub struct CompleteReopen<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [CLOCK_SEED, market.key().as_ref()], bump = clock.bump, has_one = market, has_one = calendar)]
    pub clock: Box<Account<'info, AssetClock>>,
    pub calendar: AccountLoader<'info, Calendar>,
    /// The market's auction book (may not exist: no auction ever ran).
    /// CHECK: read only when it holds an AuctionBook at the expected PDA.
    pub book: UncheckedAccount<'info>,
    /// The closure's REOPEN auction, if one was created.
    /// CHECK: read only when the book names it for this closure.
    pub auction: UncheckedAccount<'info>,
}

/// Permissionless (AuctionHouse.completeReopen): once the queue window after the open print is over and the
/// closure's REOPEN auction (if any) cleared and every loan in it settled, REOPEN ends and the market trades.
pub fn handle_complete_reopen(mut ctx: Context<CompleteReopen>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    let c = &a.clock;
    require!(c.state == ClockState::Reopen && c.open_print > 0, FinityError::WrongAuctionPhase);
    require!(now >= c.open_print_at + TIMINGS_REOPEN[0], FinityError::ReopenNotDone);
    let (book_pk, _) = Pubkey::find_program_address(&[AUCTION_BOOK_SEED, a.market.key().as_ref()], &crate::ID);
    require_keys_eq!(a.book.key(), book_pk, FinityError::WrongAuctionPhase);
    if !a.book.data_is_empty() {
        require_keys_eq!(*a.book.owner, crate::ID, FinityError::WrongAuctionPhase);
        let book = AuctionBook::try_deserialize(&mut &a.book.try_borrow_data()?[..])?;
        if book.reopen_closure == c.closure_id && book.reopen != 0 {
            let (pk, _) = Pubkey::find_program_address(&[AUCTION_SEED, a.market.key().as_ref(), &book.reopen.to_le_bytes()], &crate::ID);
            require_keys_eq!(a.auction.key(), pk, FinityError::WrongAuctionPhase);
            require_keys_eq!(*a.auction.owner, crate::ID, FinityError::WrongAuctionPhase);
            let au = Auction::try_deserialize(&mut &a.auction.try_borrow_data()?[..])?;
            require!(au.phase == PHASE_CLEARED && au.settled == au.positions, FinityError::ReopenNotDone);
        }
    }
    let c = &mut a.clock;
    c.reopen_ends_at = now;
    clk::poke(c, a.calendar.load()?.live(), &mut a.market, now)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed vector shared with client/index.ts `bidCommitment` (checked from TS too).
    #[test]
    fn commitment_vector() {
        let a = Pubkey::new_from_array([1; 32]);
        let b = Pubkey::new_from_array([2; 32]);
        let c = commitment(&a, &b, 1_234_567, 98_765_432, &[3; 32]);
        let hex: String = c.iter().map(|x| format!("{x:02x}")).collect();
        // The same bytes client/index.ts `bidCommitment` produces (checked when this vector was set).
        assert_eq!(hex, "e9e0780c14874b3929b4f40b1ba523086b9b35433aa17ef8e0295066000aca3f");
    }
}
