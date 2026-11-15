// Finity devnet keeper: every TICK_SECS it pushes prices for every market (one transaction), opens/closes
// markets on US market hours, and liquidates unhealthy positions. Run with the keeper (or admin) wallet.
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Ed25519Program, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";

import {
  BN,
  DEVNET,
  FAUCET_MAX_WHOLE,
  MARKETS,
  calendarPda,
  poolOf,
  reservePda,
  riskComputeBudget,
  clockPda,
  clockStateName,
  configPda,
  venueOf,
  fetchMarkets,
  fetchPositions,
  positionHealth,
  redeemPda,
  seniorPda,
  shareEscrowPda,
  shareMintPda,
  sessionName,
  toUnits,
  usdcVaultPda,
  vaultPda,
  AUCTION_KIND,
  CLOSURE,
  REFRESH_CU_LIMIT,
  INSTRUCTIONS_SYSVAR,
  auctionBookPda,
  noAutoCoverPda,
  oraclePda,
  priceReport,
  signedReportIx,
  guardianPda,
  auctionPda,
  lockPda,
  lotEntryPda,
  borrowRateWad,
  accrued,
  closureDays,
  coverComputeBudget,
  coverableLtv,
  epochMarketPda,
  epochPda,
  jointPda,
  marketPda,
  poolEscrowPda,
  poolPda,
  poolSharesPda,
  policyPda,
  positionPda,
  projectedDebt,
  riskConfigPda,
  riskSetPda,
  safeLtvWad,
  usdcVaultPda as usdcVault,
} from "../client/index";
import { existsSync } from "node:fs";

import { auctions } from "./auctions";
import { notify } from "./notifier";
import { NODE_FILES, loadOrCreate } from "./load-oracle";
import { log, setup } from "./env";
import { fetchQuote } from "./quotes";

const TICK_SECS = Number(process.env.TICK_SECS ?? 30);
const { payer, connection, provider, program } = setup();
const config = configPda();
const keeper = payer.publicKey;
const usdcMint = new PublicKey(DEVNET.usdcMint);
if (!DEVNET.usdcMint) throw new Error("client/devnet.json is empty: run `pnpm seed` first");

async function send(ixs: TransactionInstruction[], what: string) {
  if (ixs.length === 0) return;
  try {
    const sig = await provider.sendAndConfirm(new Transaction().add(...ixs));
    log(what, sig);
  } catch (e) {
    log(`${what} FAILED`, e instanceof Error ? e.message : e);
  }
}

/** Pushes every price, then pokes every market's clock (calendar closes, Bell times, reopen), in one transaction. */
/** Relayer heartbeat and deviation trigger: publish when the stored price is 8 min old (borrowing needs one under
 *  10 min, MAX_PRICE_AGE_SECS) or 0.2% off. */
const HEARTBEAT_SECS = Number(process.env.PRICE_HEARTBEAT_SECS ?? 480);
/** Clocks are poked only when one of their transitions fell due since the last poke (or every 30 min as a safety
 *  net): user transactions poke them too, and an idle poke is a wasted fee. */
const POKE_SAFETY_SECS = 1800;
const lastPoke = new Map<string, number>();
const sessionCache = new Map<string, number[]>();
/** Every session boundary of a venue (pre-market, open, close, after-hours), read raw from its zero-copy calendar. */
async function sessionTimes(venue: string): Promise<number[]> {
  const hit = sessionCache.get(venue);
  if (hit) return hit;
  const info = await connection.getAccountInfo(calendarPda(venue));
  if (!info) return [];
  const d = info.data;
  const len = d.readUInt32LE(16);
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const o = 24 + i * 20;
    out.push(d.readUInt32LE(o), d.readUInt32LE(o + 4), d.readUInt32LE(o + 8), d.readUInt32LE(o + 12));
  }
  sessionCache.set(venue, out);
  return out;
}
async function pokeDue(market: PublicKey, venue: string, now: number): Promise<boolean> {
  const last = lastPoke.get(market.toBase58()) ?? 0;
  if (now - last >= POKE_SAFETY_SECS) return true;
  const c = await program.account.assetClock.fetchNullable(clockPda(market));
  if (!c) return false;
  if (clockStateName(c.state) === "reopen" || (c.reopenPending && Number(c.openPrint) === 0 && now >= Number(c.reopenAt) && Number(c.reopenAt) > 0)) return true;
  const events = [c.bellWindowAt, c.bellAt, c.nextCloseAt, c.nextReopenAt, c.reopenAt, c.restrictionUntil].map(Number);
  return [...events, ...(await sessionTimes(venue))].some((t) => t > last && t <= now);
}
const DEVIATION = Number(process.env.PRICE_DEVIATION ?? 0.002);
/** Relayer processes (scripts/relayer.ts), each with its own key: comma-separated base URLs. Unset = the keeper
 *  signs with the relayer keys itself (local development before the relayers are running). */
const RELAYER_URLS = (process.env.RELAYER_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
const relayers = RELAYER_URLS.length === 0 && existsSync(NODE_FILES[0]!) ? NODE_FILES.map(loadOrCreate) : [];

type Report = { signer: PublicKey; price: bigint; observedAt: number; signature: Uint8Array };
/** The latest signed report of every relayer, by market. A relayer that is down just contributes nothing. */
async function collectReports(): Promise<Map<string, Report[]>> {
  const out = new Map<string, Report[]>();
  await Promise.all(
    RELAYER_URLS.map(async (base) => {
      try {
        const res = await fetch(`${base.replace(/\/$/, "")}/v1/reports`, { signal: AbortSignal.timeout(5_000) });
        const body = (await res.json()) as { signer: string; reports: { market: string; price: string; observedAt: number; signature: string }[] };
        for (const r of body.reports) {
          const list = out.get(r.market) ?? [];
          list.push({ signer: new PublicKey(body.signer), price: BigInt(r.price), observedAt: r.observedAt, signature: Buffer.from(r.signature, "base64") });
          out.set(r.market, list);
        }
      } catch (e) {
        log(`relayer ${base} unreachable:`, e instanceof Error ? e.message : e);
      }
    }),
  );
  return out;
}
const median = (xs: bigint[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor((xs.length - 1) / 2)]!;

/** Prices, then every market's clock. With an oracle configured, prices go as signed reports from the relayer
 *  nodes (k of n, checked on-chain); before that (bootstrap), as keeper pushes. */
async function pricesAndClocks() {
  const now = Math.floor(Date.now() / 1000);
  const markets = await fetchMarkets(program);
  const oracle = await program.account.oracleConfig.fetchNullable(oraclePda());
  const signed = !!oracle && !oracle.keeperPriceAllowed;
  if (signed && RELAYER_URLS.length === 0 && relayers.length < oracle!.threshold) {
    throw new Error("oracle configured but no relayers: set RELAYER_URLS (or run `pnpm load-oracle` for local keys)");
  }
  const remote = signed && RELAYER_URLS.length > 0 ? await collectReports() : null;
  // A market without a clock (not loaded yet) still gets its price.
  const hasClock = (await connection.getMultipleAccountsInfo(markets.map((m) => clockPda(m.publicKey)))).map((a) => a !== null);
  const pokes: TransactionInstruction[] = [];
  const pushes: TransactionInstruction[] = [];
  const summary: string[] = [];
  for (const [idx, { publicKey: market, account: m }] of markets.entries()) {
    const spec = MARKETS.find((s) => s.symbol === m.symbol);
    if (!spec) continue;
    try {
      if (remote) {
        // Reports newer than the stored price and inside the freshness window; one per signer.
        const stored = BigInt(m.price.toString());
        const reports = (remote.get(market.toBase58()) ?? []).filter(
          (r) => r.observedAt > Number(m.priceUpdatedAt) && r.observedAt >= now - Number(oracle!.maxDelaySecs) && r.observedAt <= now + Number(oracle!.maxAheadSecs),
        );
        const age = now - Number(m.priceUpdatedAt.toString());
        if (reports.length >= oracle!.threshold) {
          const mid = median(reports.map((r) => r.price));
          const moved = stored > 0n && Math.abs(Number(mid - stored)) / Number(stored) >= DEVIATION;
          if (age >= HEARTBEAT_SECS || moved) {
            const ixs: TransactionInstruction[] = reports.map((r) =>
              Ed25519Program.createInstructionWithPublicKey({ publicKey: r.signer.toBytes(), message: priceReport(market, r.price, r.observedAt), signature: r.signature }),
            );
            ixs.push(await program.methods.submitPrices().accountsPartial({ oracle: oraclePda(), market, instructions: INSTRUCTIONS_SYSVAR }).instruction());
            await send(ixs, `signed price ${m.symbol}=${(Number(mid) / 1e6).toFixed(2)} (${reports.length} relayers${moved ? ", moved" : ""})`);
          }
          summary.push(`${m.symbol}=${(Number(mid) / 1e6).toFixed(2)}`);
        } else {
          log(`${m.symbol}: ${reports.length} fresh relayer reports, ${oracle!.threshold} needed`);
        }
        if (hasClock[idx] && (await pokeDue(market, spec.venue, now))) {
          pokes.push(await program.methods.poke().accountsPartial({ market, clock: clockPda(market), calendar: calendarPda(spec.venue) }).instruction());
          lastPoke.set(market.toBase58(), now);
        }
        continue;
      }
      const q = await fetchQuote(spec.quote);
      const price = BigInt(toUnits(q.price).toString());
      const stored = BigInt(m.price.toString());
      const age = now - Number(m.priceUpdatedAt.toString());
      const moved = stored > 0n && Math.abs(Number(price - stored)) / Number(stored) >= DEVIATION;
      if (signed) {
        if (age >= HEARTBEAT_SECS || moved) {
          // Each node signs its own observation; on devnet the three share one quote source.
          const ixs = relayers.map((k) => signedReportIx(k, market, price, now));
          ixs.push(await program.methods.submitPrices().accountsPartial({ oracle: oraclePda(), market, instructions: INSTRUCTIONS_SYSVAR }).instruction());
          await send(ixs, `signed price ${m.symbol}=${q.price.toFixed(2)} (${relayers.length} nodes${moved ? ", moved" : ""})`);
        }
      } else {
        pushes.push(await program.methods.setPrice(toUnits(q.price)).accountsPartial({ authority: keeper, config, market, oracle: oraclePda() }).instruction());
      }
      summary.push(`${m.symbol}=${q.price.toFixed(2)}`);
    } catch (e) {
      log(`${m.symbol} quote failed`, e instanceof Error ? e.message : e);
    }
    if (hasClock[idx] && (await pokeDue(market, spec.venue, now))) {
      pokes.push(await program.methods.poke().accountsPartial({ market, clock: clockPda(market), calendar: calendarPda(spec.venue) }).instruction());
      lastPoke.set(market.toBase58(), now);
    }
  }
  if (pushes.length || pokes.length) await send([...pushes, ...pokes], `${signed ? `clocks (${pokes.length})` : "prices+clocks"} ${summary.join(" ")}`);
  const clocks = await program.account.assetClock.fetchMultiple(markets.map((m) => clockPda(m.publicKey)));
  log("clocks", markets.map((m, i) => `${m.account.symbol}:${clocks[i] ? clockStateName(clocks[i]!.state) : "?"}`).join(" "));
}


/** Pays queued senior-vault redemptions once liquidity allows (permissionless crank, SeniorVault.processQueue). */
async function redeemQueue() {
  const v = await program.account.seniorVault.fetch(seniorPda());
  const head = Number(v.queueHead.toString());
  const next = Number(v.nextRequestId.toString());
  if (head >= next) return;
  const ids = Array.from({ length: Math.min(8, next - head) }, (_, i) => head + i);
  const ix = await program.methods
    .processRedeemQueue()
    .accountsPartial({ cranker: keeper, senior: seniorPda(), shareMint: shareMintPda(), shareEscrow: shareEscrowPda(), tokenProgram: TOKEN_PROGRAM_ID })
    .remainingAccounts([
      ...v.markets.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ...ids.map((id) => ({ pubkey: redeemPda(id), isSigner: false, isWritable: true })),
    ])
    .instruction();
  await send([ix], `redeem queue ${head}..${next - 1}`);
}

const VENUES = ["XNYS", "USBANK"] as const;
const exists = async (k: PublicKey) => (await connection.getAccountInfo(k)) !== null;
let tickNo = 0;

/** R-09: every 10 ticks, move each market's interest shares to its pool and the protocol reserve. */
async function sweepFees() {
  if (tickNo % 10 !== 0) return;
  const ixs: TransactionInstruction[] = [];
  for (const { publicKey: market, account: m } of await fetchMarkets(program)) {
    if (m.poolFeeAccrued.isZero() && m.treasuryFeeAccrued.isZero()) continue;
    ixs.push(await program.methods.sweepFees().accountsPartial({ senior: seniorPda(), market, pool: poolOf(m.symbol), reserve: reservePda() }).instruction());
  }
  await send(ixs, `sweep fees (${ixs.length} markets)`);
}

/** The pools' epochs: open the next one, snapshot J at the Bell deadline, refresh capacity, enforce the Bell, settle. */
/** The fingerprint each EpochMarket was last refreshed at. */
const lastRefresh = new Map<string, string>();

/** Closes the per-market accounts of settled epochs (their rent comes back to the keeper). */
async function closeSettled(pool: PublicKey, markets: PublicKey[], upTo: number) {
  for (let s = Math.max(1, upTo - 3); s <= upTo; s++) {
    const epoch = epochPda(pool, s);
    const e = await program.account.epoch.fetchNullable(epoch);
    if (!e || e.phase !== 3) continue;
    for (const market of markets) {
      const em = epochMarketPda(epoch, market);
      if (!(await exists(em))) continue;
      const ix = await program.methods.closeEpochMarket().accountsPartial({ config, epoch, epochMarket: em, keeper }).instruction();
      await send([ix], `close settled epoch #${s} market ${market.toBase58().slice(0, 6)} (rent back)`);
    }
  }
}

async function epochs() {
  const now = Math.floor(Date.now() / 1000);
  for (const venue of VENUES) {
    const pool = poolPda(venue);
    if (!(await exists(pool))) continue;
    const p = await program.account.underwriterPool.fetch(pool);
    const seq = Number(p.epochsOpened.toString());
    if (tickNo % 20 === 0 || !p.epochActive) await closeSettled(pool, p.markets, p.epochActive ? seq - 1 : seq);
    if (!p.epochActive) {
      await send(
        [await program.methods.openEpoch().accountsPartial({ cranker: keeper, pool, calendar: calendarPda(venue), epoch: epochPda(pool, seq + 1), systemProgram: SystemProgram.programId }).instruction()],
        `${venue} open epoch #${seq + 1}`,
      );
      continue;
    }
    const epoch = epochPda(pool, seq);
    const e = await program.account.epoch.fetch(epoch);
    const [bellAt, closeAt, reopenAt] = [Number(e.bellAt), Number(e.closeAt), Number(e.reopenAt)];

    // Settle once every market finished the reopen (the program checks each clock).
    if (now >= reopenAt + 120 + 300) {
      const ix = await program.methods
        .settleEpoch()
        .accountsPartial({ pool, epoch, shareMint: poolSharesPda(venue), escrow: poolEscrowPda(venue), tokenProgram: TOKEN_PROGRAM_ID })
        .remainingAccounts(p.markets.map((m) => ({ pubkey: clockPda(m), isSigner: false, isWritable: false })))
        .instruction();
      await send([ix], `${venue} settle epoch #${seq}`);
      continue;
    }
    if (e.phase === 1 && now >= bellAt) {
      await send([await program.methods.snapshotEpoch().accountsPartial({ pool, epoch }).instruction()], `${venue} snapshot epoch #${seq}`);
    }
    if (now >= closeAt) continue; // the closure is under way: capacity and the Bell are done

    // Each market's epoch account, then its uncovered bound (one transaction per market: ~410k CU each), only when
    // what the bound depends on changed: the market's collateral or debt, or its price by 0.5%. Covers refresh their
    // own market as they are written; one pass when the Bell window opens catches anything else.
    const inBell = now >= Number(e.bellWindowAt);
    const markets = await program.account.market.fetchMultiple(p.markets);
    for (const [i, market] of p.markets.entries()) {
      const em = epochMarketPda(epoch, market);
      const m = markets[i];
      const print = m
        ? `${m.totalCollateral}:${m.totalBorrowAssets}:${Math.round(Math.log(Math.max(1, Number(m.price))) / Math.log(1.005))}:${inBell}`
        : "";
      if (lastRefresh.get(em.toBase58()) === print && (await exists(em))) continue;
      const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: REFRESH_CU_LIMIT })];
      if (!(await exists(em))) {
        ixs.push(await program.methods.initEpochMarket().accountsPartial({ cranker: keeper, pool, epoch, market, epochMarket: em, systemProgram: SystemProgram.programId }).instruction());
      }
      ixs.push(
        await program.methods
          .refreshCapacity()
          .accountsPartial({ pool, epoch, epochMarket: em, market, riskConfig: riskConfigPda(), riskSet: riskSetPda(market, e.closureType), joint: jointPda(market) })
          .instruction(),
      );
      await send(ixs, `${venue} capacity ${market.toBase58().slice(0, 6)}`);
      lastRefresh.set(em.toBase58(), print);
    }

    if (now >= bellAt) await bell(venue, pool, epoch, p.markets, e.closureType);
  }
}

/** The Bell: between the deadline and the close, auto-cover every uncovered loan above the closure's safe LTV. */
async function bell(venue: string, pool: PublicKey, epoch: PublicKey, markets: PublicKey[], closureType: number) {
  const cfg = await program.account.riskConfig.fetch(riskConfigPda());
  const now = Math.floor(Date.now() / 1000);
  for (const market of markets) {
    const m = await program.account.market.fetch(market);
    const c = await program.account.assetClock.fetch(clockPda(market));
    const set = await program.account.riskSet.fetch(riskSetPda(market, closureType));
    const safe = Number(safeLtvWad({ n: set.n, sigma: set.sigma, dividend: set.dividend, zTail: set.zTail }, cfg, m.maxLtvBps)) / 1e18;
    const days = closureDays(Number(c.nextCloseAt), Number(c.nextReopenAt)) ?? 4;
    const l = accrued(m, now);
    const rate = borrowRateWad(l.supply, l.borrow, m.rate);
    for (const { publicKey: position, account: pos } of await fetchPositions(program)) {
      if (!pos.market.equals(market) || pos.borrowShares.isZero()) continue;
      const policy = policyPda(market, pos.owner, Number(c.closureId) + 1);
      if (await exists(policy)) continue;
      const h = positionHealth(m, pos, now);
      const dProj = Number(projectedDebt(h.debtRaw, rate, days)) / 1e6;
      if (h.value === 0 || dProj / h.value <= safe) continue; // SAFE
      const optedOut = await exists(noAutoCoverPda(position));
      if (optedOut || h.debt / h.value > coverableLtv(m.maxLtvBps, m.liqThresholdBps)) {
        // Too risky to cover: the Bell's cure is the pre-close sale down to the safe LTV (R-03, R-06).
        if (now >= Number(c.nextCloseAt) - 300) continue; // its lot is already fixed
        const lock = await program.account.positionLock.fetchNullable(lockPda(position));
        if (lock && !lock.auction.equals(PublicKey.default)) continue;
        const book = await program.account.auctionBook.fetchNullable(auctionBookPda(market));
        const upcoming = Number(c.closureId) + 1;
        const id = book && Number(book.precloseClosure) === upcoming && Number(book.preclose) > 0 ? Number(book.preclose) : (book ? Number(book.nextId) : 0) + 1;
        const ix = await program.methods
          .flag(AUCTION_KIND.PRECLOSE, new BN(id))
          .accountsPartial({
            cranker: keeper, senior: seniorPda(), market, position, clock: clockPda(market), calendar: calendarPda(venue),
            riskConfig: riskConfigPda(), riskSet: riskSetPda(market, c.nextClosureType), policy, optOut: noAutoCoverPda(position),
            book: auctionBookPda(market),
            auction: auctionPda(market, id), entry: lotEntryPda(auctionPda(market, id), pos.owner), lock: lockPda(position),
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        await send([ix], `bell ${m.symbol} ${pos.owner.toBase58().slice(0, 6)}: above the coverable LTV → pre-close sale #${id}`);
        continue;
      }
      const ix = await program.methods
        .writeCover(new BN(0), true, true)
        .accountsPartial({
          payer: keeper, config, senior: seniorPda(), market, position, clock: clockPda(market), calendar: calendarPda(venue),
          riskConfig: riskConfigPda(), riskSet: riskSetPda(market, c.nextClosureType), joint: jointPda(market), pool, epoch,
          epochMarket: epochMarketPda(epoch, market), policy, guardianState: guardianPda(), optOut: noAutoCoverPda(position),
          ownerUsdc: null, usdcVault: usdcVault(),
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .instruction();
      await send([coverComputeBudget(), ix], `bell auto-cover ${m.symbol} ${pos.owner.toBase58().slice(0, 6)} (${(100 * dProj / h.value).toFixed(1)}% > ${(100 * safe).toFixed(1)}%)`);
    }
  }
}

log("keeper", keeper.toBase58(), "tick", TICK_SECS, "s");
const once = process.argv.includes("--once");
for (;;) {
  try {
    if (!process.env.BOT_SKIP_PRICES) await pricesAndClocks();
    await auctions({ program, connection, keeper, usdcMint, send, log });
    await redeemQueue();
    await sweepFees();
    await epochs();
    if (tickNo % 2 === 0) await notify(program, log).catch((e) => log("notifier failed", e instanceof Error ? e.message : e));
    tickNo++;
  } catch (e) {
    log("tick failed", e instanceof Error ? e.message : e);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, TICK_SECS * 1000));
}
