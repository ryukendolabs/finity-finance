// Auction keeper and solver:
//  - flags unhealthy loans into INTRADAY (regular session), EMERGENCY (extended hours, uncovered loans only) or
//    REOPEN (at the open print) auctions;
//  - fixes each position's lot at the deadline, clears with every bid, settles every loan, ends the REOPEN;
//  - as a solver, bids on open lots at 1% under the live price (a T-Bill lot: 0.3% under NAV, inside its κ_nav
//    reserve; REOPEN: sealed commit, then reveal), and claims what it wins;
//  - runs the pool's backstop inventory: re-marks it, lists stock inventory in a GDA in the regular session, ends
//    GDAs that ran their course, and hands T-Bill inventory to the fund, claiming each redemption when it is paid.
//  Untrusted by design: every step is checked on-chain.
import { randomBytes } from "node:crypto";

import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";

import {
  AUCTION_KIND,
  BN,
  CLOSURE,
  FAUCET_MAX_WHOLE,
  auctionBookPda,
  auctionIdFor,
  auctionPda,
  bidCommitment,
  bidPda,
  calendarPda,
  clockPda,
  clockStateName,
  configPda,
  fetchMarkets,
  fetchPositions,
  GDA_MAX_RUN_SECS,
  inventoryPda,
  lockPda,
  lotEntryPda,
  noAutoCoverPda,
  policyPda,
  poolOf,
  positionHealth,
  positionPda,
  redemptionPda,
  reservePda,
  riskConfigPda,
  riskSetPda,
  seniorPda,
  toUnits,
  usdcVaultPda,
  vaultPda,
  venueOf,
  type Finity,
} from "../client/index";
import type { Program } from "@anchor-lang/core";

type Send = (ixs: TransactionInstruction[], what: string) => Promise<void>;
type Ctx = { program: Program<Finity>; connection: Connection; keeper: PublicKey; usdcMint: PublicKey; send: Send; log: (...a: unknown[]) => void };

const PHASE_CLEARED = 4;
/** Sealed bids this process committed: salt and terms, to reveal later. */
const sealed = new Map<string, { qty: bigint; price: bigint; salt: Uint8Array }>();

export async function auctions(c: Ctx) {
  const { program, keeper } = c;
  const now = Math.floor(Date.now() / 1000);
  const [markets, positions] = await Promise.all([fetchMarkets(program), fetchPositions(program)]);
  for (const { publicKey: market, account: m } of markets) {
    const clock = await program.account.assetClock.fetch(clockPda(market));
    const state = clockStateName(clock.state);
    const venue = venueOf(m.symbol);
    const book = await program.account.auctionBook.fetchNullable(auctionBookPda(market));

    // 1. Flag: health below 1 (live in the regular session and extended hours, at the open print in REOPEN).
    const kind =
      state === "regular" ? AUCTION_KIND.INTRADAY :
      state === "extended" ? AUCTION_KIND.EMERGENCY :
      state === "reopen" && now < Number(clock.openPrintAt) + 120 ? AUCTION_KIND.REOPEN : null;
    if (kind !== null) {
      // The joinable auction: in its queue phase and before its lot-fix deadline.
      const candidate = auctionIdFor(book, kind, Number(clock.closureId), () => true);
      const existing = await program.account.auction.fetchNullable(auctionPda(market, candidate));
      const open = !!existing && existing.phase === 1 && now < Number(existing.deadlines[0]);
      const useId = existing && !open ? Number(book!.nextId) + 1 : candidate;
      for (const { publicKey: position, account: p } of positions) {
        if (!p.market.equals(market) || p.borrowShares.isZero() || p.collateral.isZero()) continue;
        const lock = await program.account.positionLock.fetchNullable(lockPda(position));
        if (lock && !lock.auction.equals(PublicKey.default)) continue; // already in a lot
        const price = kind === AUCTION_KIND.REOPEN ? clock.openPrint : m.price;
        if (!positionHealth({ ...m, price }, p, now).liquidatable) continue;
        // EMERGENCY never sells a loan covered for the closure in progress (the program checks it too).
        const policyClosure = kind === AUCTION_KIND.EMERGENCY ? Number(clock.closureId) : Number(clock.closureId) + 1;
        if (kind === AUCTION_KIND.EMERGENCY && (await c.connection.getAccountInfo(policyPda(market, p.owner, policyClosure)))) continue;
        const ix = await program.methods
          .flag(kind, new BN(useId))
          .accountsPartial({
            cranker: keeper, senior: seniorPda(), market, position, clock: clockPda(market), calendar: calendarPda(venue),
            riskConfig: riskConfigPda(), riskSet: riskSetPda(market, CLOSURE.OVERNIGHT),
            policy: policyPda(market, p.owner, policyClosure), optOut: noAutoCoverPda(position),
            book: auctionBookPda(market),
            auction: auctionPda(market, useId), entry: lotEntryPda(auctionPda(market, useId), p.owner), lock: lockPda(position),
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        const kindName = kind === AUCTION_KIND.REOPEN ? "REOPEN" : kind === AUCTION_KIND.EMERGENCY ? "EMERGENCY" : "INTRADAY";
        await c.send([ix], `flag ${kindName} ${m.symbol} ${p.owner.toBase58().slice(0, 6)} → #${useId}`);
        break; // one per tick per market: the next flag sees the updated book
      }
    }

    // 2. Every live auction of the market (the last few ids).
    const last = book ? Number(book.nextId) : 0;
    for (let id = Math.max(1, last - 4); id <= last; id++) {
      const key = auctionPda(market, id);
      const a = await program.account.auction.fetchNullable(key);
      if (!a || a.phase === 5) continue;
      const d = a.deadlines.map(Number);
      const entries = await program.account.lotEntry.all([{ memcmp: { offset: 8, bytes: key.toBase58() } }]);
      const bids = await program.account.bid.all([{ memcmp: { offset: 8, bytes: key.toBase58() } }]);

      if (a.phase !== PHASE_CLEARED) {
        // Fix every queued position once the lot-fix deadline passed.
        if (now >= d[0]! && now < d[2]!) {
          for (const e of entries.filter((e) => !e.account.fixed)) {
            const ix = await program.methods
              .fixPosition()
              .accountsPartial({
                senior: seniorPda(), market, position: positionOf(market, e.account.owner), clock: clockPda(market),
                riskConfig: riskConfigPda(), auction: key, entry: e.publicKey,
              })
              .instruction();
            await c.send([ix], `fix #${id} ${m.symbol} ${e.account.owner.toBase58().slice(0, 6)}`);
          }
        }
        await solve(c, market, m, key, a, bids.find((b) => b.account.bidder.equals(keeper))?.account ?? null, now);
        // Clear with every bid at the deadline.
        if (now >= d[3]!) {
          const fresh = await program.account.bid.all([{ memcmp: { offset: 8, bytes: key.toBase58() } }]);
          const ix = await program.methods
            .clearAuction()
            .accountsPartial({
              cranker: keeper, config: configPda(), market, riskConfig: riskConfigPda(), auction: key, pool: poolOf(m.symbol),
              collateralMint: m.collateralMint, vault: vaultOf(market),
              inventory: getAssociatedTokenAddressSync(m.collateralMint, poolOf(m.symbol), true),
              inventoryState: inventoryPda(poolOf(m.symbol), m.collateralMint),
              tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(fresh.map((b) => ({ pubkey: b.publicKey, isSigner: false, isWritable: true })))
            .instruction();
          await c.send([ix], `clear #${id} ${m.symbol} lot ${a.lot.toString()} with ${fresh.length} bids`);
        }
        continue;
      }
      // Cleared: settle every loan, then claim the solver's fill.
      for (const e of entries.filter((e) => !e.account.settled)) {
        const ix = await program.methods
          .settleLotPosition()
          .accountsPartial({
            cranker: keeper, config: configPda(), senior: seniorPda(), market, position: positionOf(market, e.account.owner),
            auction: key, entry: e.publicKey, lock: lockPda(positionOf(market, e.account.owner)), pool: poolOf(m.symbol),
            reserve: reservePda(), usdcMint: c.usdcMint, ownerUsdc: getAssociatedTokenAddressSync(c.usdcMint, e.account.owner),
            owner: e.account.owner, usdcVault: usdcVaultPda(), tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .instruction();
        await c.send([ix], `settle #${id} ${m.symbol} ${e.account.owner.toBase58().slice(0, 6)}`);
      }
      const mine = bids.find((b) => b.account.bidder.equals(keeper) && !b.account.claimed);
      if (mine) await c.send([await claimIx(c, market, m.collateralMint, key)], `solver claims #${id}: ${mine.account.fill.toString()} tokens`);
    }

    // 3. End the REOPEN once its queue window passed and its auction (if any) settled.
    if (state === "reopen" && clock.openPrint.gtn(0) && now >= Number(clock.openPrintAt) + 120) {
      const reopenId = book && Number(book.reopenClosure) === Number(clock.closureId) ? Number(book.reopen) : 0;
      const ix = await program.methods
        .completeReopen()
        .accountsPartial({ market, clock: clockPda(market), calendar: calendarPda(venue), book: auctionBookPda(market), auction: auctionPda(market, reopenId) })
        .instruction();
      await c.send([ix], `complete reopen ${m.symbol}`);
    }

    // 4. The pool's backstop inventory of this token.
    await inventory(c, market, m, state, now);
  }
  await redemptions(c, now);
}

/** Re-mark, resell (stocks) or redeem (T-Bill) the pool's inventory of one market's token. */
async function inventory(
  c: Ctx,
  market: PublicKey,
  m: { symbol: string; collateralMint: PublicKey; price: BN; collateralDecimals: number },
  state: string,
  now: number,
) {
  const { program, keeper } = c;
  const pool = poolOf(m.symbol);
  const key = inventoryPda(pool, m.collateralMint);
  const inv = await program.account.inventory.fetchNullable(key);
  if (!inv) return;
  const base = { pool, inventory: key, market, riskConfig: riskConfigPda() };
  if (inv.nav) {
    if (inv.qty.isZero()) return;
    const pool_ = await program.account.underwriterPool.fetch(pool);
    const ix = await program.methods
      .requestRedemption()
      .accountsPartial({
        cranker: keeper, pool, inventory: key, market, collateralMint: m.collateralMint,
        poolTokens: getAssociatedTokenAddressSync(m.collateralMint, pool, true),
        redemption: redemptionPda(pool, Number(pool_.redemptions) + 1), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .instruction();
    await c.send([ix], `redeem ${inv.qty.toString()} ${m.symbol} with the fund (T+1)`);
    return;
  }
  if (inv.qty.isZero()) return;
  // Re-mark when the price moved the mark by more than 0.5%.
  const scale = 10 ** m.collateralDecimals;
  const want = Math.min((Number(inv.qty) * Number(m.price)) / scale, Number(inv.cost)); // κ applied on-chain; close enough to trigger
  if (Math.abs(want - Number(inv.mark)) > Number(inv.mark) * 0.005 + 1) {
    await c.send([await program.methods.markInventory().accountsPartial(base).instruction()], `re-mark ${m.symbol} inventory`);
  }
  if (inv.gda.active && now >= Number(inv.gda.start) + GDA_MAX_RUN_SECS) {
    const ix = await program.methods.closeGda().accountsPartial({ signer: keeper, config: configPda(), ...base }).instruction();
    await c.send([ix], `end the ${m.symbol} GDA (${inv.gda.sold.toString()} of ${inv.gda.qty.toString()} sold)`);
  } else if (!inv.gda.active && state === "regular") {
    const ix = await program.methods
      .resellInventory()
      .accountsPartial({ ...base, clock: clockPda(market), calendar: calendarPda(venueOf(m.symbol)) })
      .instruction();
    await c.send([ix], `list ${inv.qty.toString()} ${m.symbol} in a GDA`);
  }
}

/** Claims every T-Bill redemption the fund has paid. */
async function redemptions(c: Ctx, now: number) {
  const open = (await c.program.account.redemption.all()).filter((r) => !r.account.claimed && now >= Number(r.account.readyAt));
  for (const { publicKey, account: r } of open) {
    const ix = await c.program.methods
      .claimRedemption()
      .accountsPartial({
        config: configPda(), usdcMint: c.usdcMint, usdcVault: usdcVaultPda(), pool: r.pool, market: r.market, redemption: publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    await c.send([ix], `claim redemption #${r.id.toString()} (${r.qty.toString()} T-Bill)`);
  }
}

const positionOf = (market: PublicKey, owner: PublicKey) => positionPda(market, owner);
const vaultOf = (market: PublicKey) => vaultPda(market);

async function claimIx(c: Ctx, market: PublicKey, mint: PublicKey, auction: PublicKey) {
  return c.program.methods
    .claimBid()
    .accountsPartial({
      bidder: c.keeper, config: configPda(), market, auction, bid: bidPda(auction, c.keeper), usdcMint: c.usdcMint, collateralMint: mint,
      vault: vaultOf(market), bidderCollateral: getAssociatedTokenAddressSync(mint, c.keeper), bidderUsdc: getAssociatedTokenAddressSync(c.usdcMint, c.keeper),
      usdcVault: usdcVaultPda(), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** The solver: one bid per auction at min(live price × 0.99, …) ≥ the reserve, funded from the USDC faucet. */
async function solve(
  c: Ctx,
  market: PublicKey,
  m: { price: BN; collateralDecimals: number },
  auction: PublicKey,
  a: { kind: number; lot: BN; reserve: BN; deadlines: BN[]; nav: boolean },
  mine: { revealed: boolean; commitment: number[] } | null,
  now: number,
) {
  const d = a.deadlines.map(Number);
  // A T-Bill lot's reserve is 0.5% under NAV: a solver paying cash now and waiting out the redemption bids 0.3% under.
  const price = BigInt(m.price.toString()) * (a.nav ? 997n : 990n) / 1000n;
  const reserve = BigInt(a.reserve.toString());
  const lot = BigInt(a.lot.toString());
  if (lot === 0n || price < reserve) return;
  const scale = 10n ** BigInt(m.collateralDecimals);
  const notional = (lot * price) / scale;
  const accounts = {
    bidder: c.keeper, config: configPda(), market, auction, bid: bidPda(auction, c.keeper),
    bidderUsdc: getAssociatedTokenAddressSync(c.usdcMint, c.keeper), usdcVault: usdcVaultPda(), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
  const fund = async (usdc: bigint) => {
    const calls = Math.min(30, Math.ceil(Number(usdc) / 1e6 / FAUCET_MAX_WHOLE) + 1);
    const ixs: TransactionInstruction[] = [];
    for (let i = 0; i < calls; i++) {
      ixs.push(
        await c.program.methods
          .faucet(toUnits(FAUCET_MAX_WHOLE))
          .accountsPartial({
            user: c.keeper, config: configPda(), mint: c.usdcMint, userToken: accounts.bidderUsdc,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
    }
    return ixs;
  };
  if (a.kind !== AUCTION_KIND.REOPEN) {
    if (mine || now < d[1]! || now >= d[2]!) return;
    const ix = await c.program.methods.placeBid(new BN(lot.toString()), new BN(price.toString())).accountsPartial(accounts).instruction();
    await c.send([...(await fund(notional)), ix], `solver bids ${lot} @ ${Number(price) / 1e6}`);
    return;
  }
  // REOPEN: commit in [biddingStart, commitEnd), reveal in [commitEnd, clearAt).
  const k = auction.toBase58();
  if (!mine && now >= d[1]! && now < d[2]!) {
    const salt = randomBytes(32);
    sealed.set(k, { qty: lot, price, salt });
    const ix = await c.program.methods
      .commitBid(bidCommitment(auction, c.keeper, lot, price, salt), new BN((notional + 1n).toString()))
      .accountsPartial(accounts)
      .instruction();
    await c.send([...(await fund(notional)), ix], `solver commits (sealed) on ${k.slice(0, 6)}`);
  } else if (mine && !mine.revealed && now >= d[2]! && now < d[3]! && sealed.has(k)) {
    const s = sealed.get(k)!;
    const ix = await c.program.methods
      .revealBid(new BN(s.qty.toString()), new BN(s.price.toString()), Array.from(s.salt))
      .accountsPartial(accounts)
      .instruction();
    await c.send([ix], `solver reveals ${s.qty} @ ${Number(s.price) / 1e6}`);
  }
}
