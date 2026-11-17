// The indexer: keeps the history the chain doesn't serve cheaply, in SQLite (~/.local/share/finity/index.db).
//  - every program transaction (signature, slot, time, instruction names, error), from getSignaturesForAddress;
//  - price updates and market-clock transitions per market;
//  - each auction's lifecycle (upserted as it moves);
//  - pool NAV snapshots (free cash, inventory mark, redemption claims) every 5 minutes.
// Read by the public API (scripts/api.ts). Idempotent: rows are keyed, so restarts resume where they stopped.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { BorshInstructionCoder } from "@anchor-lang/core";
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import Database from "better-sqlite3";

import {
  AUCTION_KIND_NAME,
  PROGRAM_ID,
  auctionBookPda,
  auctionPda,
  clockPda,
  clockStateName,
  fetchMarkets,
  idl,
  poolFreeCash,
  poolNav,
  poolPda,
} from "../client/index";
import { log, setup } from "./env";

export const INDEX_DB = process.env.FINITY_INDEX_DB ?? `${homedir()}/.local/share/finity/index.db`;
const TICK_SECS = Number(process.env.INDEXER_TICK_SECS ?? 20);
const POOL_EVERY_SECS = 300;

export function openIndex(readonly = false): Database.Database {
  mkdirSync(dirname(INDEX_DB), { recursive: true });
  const db = new Database(INDEX_DB, { readonly: readonly && false });
  db.pragma("journal_mode = WAL");
  db.exec(`
    create table if not exists txs (
      signature text primary key, slot integer not null, block_time integer, ixs text not null, err text
    );
    create index if not exists txs_slot on txs (slot desc);
    create table if not exists prices (
      symbol text not null, price real not null, at integer not null, primary key (symbol, at)
    );
    create table if not exists clock_states (
      symbol text not null, state text not null, closure_id integer not null, at integer not null,
      primary key (symbol, at, state)
    );
    create table if not exists auctions (
      market text not null, symbol text not null, id integer not null, kind text not null, phase integer not null,
      lot real not null, reserve real not null, p_star real not null, q_pool real not null, bids integer not null,
      clear_at integer not null, nav integer not null, updated_at integer not null, primary key (market, id)
    );
    create table if not exists pools (
      venue text not null, at integer not null, nav real not null, free_cash real not null,
      inventory_mark real not null, claims_cost real not null, losses_paid real not null, primary key (venue, at)
    );
    create table if not exists meta (k text primary key, v text not null);
  `);
  return db;
}

const { connection, program } = setup();
const db = openIndex();
const coder = new BorshInstructionCoder(idl as never);
const meta = {
  get: (k: string) => (db.prepare("select v from meta where k = ?").get(k) as { v: string } | undefined)?.v,
  set: (k: string, v: string) => db.prepare("insert into meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v").run(k, v),
};

/** New program transactions since the last one indexed (newest first from RPC; stored oldest first). */
async function transactions() {
  const until = meta.get("last_signature");
  const page: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  // A first run starts from the latest 100 (no deep backfill); after that, everything since the last one indexed.
  for (let i = 0; i < (until ? 10 : 1); i++) {
    const batch = await connection.getSignaturesForAddress(PROGRAM_ID, { before, until, limit: 100 }, "confirmed");
    page.push(...batch);
    if (batch.length < 100) break;
    before = batch[batch.length - 1]!.signature;
  }
  if (!page.length) return 0;
  const insert = db.prepare("insert or ignore into txs (signature, slot, block_time, ixs, err) values (?, ?, ?, ?, ?)");
  const ordered = page.reverse();
  const txs: Awaited<ReturnType<typeof connection.getTransactions>> = [];
  // 10 per batch with a pause: a batch counts as one request per item against the RPC's rate limit.
  for (let i = 0; i < ordered.length; i += 10) {
    txs.push(...(await connection.getTransactions(ordered.slice(i, i + 10).map((s) => s.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 })));
    await new Promise((r) => setTimeout(r, 400));
  }
  for (const [n, s] of ordered.entries()) {
    let names: string[] = [];
    try {
      const tx = txs[n];
      const keys = tx?.transaction.message.getAccountKeys().staticAccountKeys ?? [];
      for (const ix of tx?.transaction.message.compiledInstructions ?? []) {
        if (!keys[ix.programIdIndex]?.equals(PROGRAM_ID)) continue;
        const d = coder.decode(Buffer.from(ix.data));
        if (d) names.push(d.name);
      }
    } catch {
      names = ["?"];
    }
    insert.run(s.signature, s.slot, s.blockTime ?? null, names.join(","), s.err ? JSON.stringify(s.err) : null);
    meta.set("last_signature", s.signature);
  }
  return page.length;
}

async function markets(now: number) {
  const list = await fetchMarkets(program);
  const price = db.prepare("insert or ignore into prices (symbol, price, at) values (?, ?, ?)");
  const lastState = db.prepare("select state from clock_states where symbol = ? order by at desc limit 1");
  const state = db.prepare("insert or ignore into clock_states (symbol, state, closure_id, at) values (?, ?, ?, ?)");
  const auction = db.prepare(`
    insert into auctions (market, symbol, id, kind, phase, lot, reserve, p_star, q_pool, bids, clear_at, nav, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (market, id) do update set phase = excluded.phase, lot = excluded.lot, reserve = excluded.reserve,
      p_star = excluded.p_star, q_pool = excluded.q_pool, bids = excluded.bids, updated_at = excluded.updated_at`);
  for (const { publicKey: market, account: m } of list) {
    const scale = 10 ** m.collateralDecimals;
    price.run(m.symbol, Number(m.price) / 1e6, Number(m.priceUpdatedAt));
    const c = await program.account.assetClock.fetchNullable(clockPda(market));
    if (c) {
      const s = clockStateName(c.state);
      const prev = (lastState.get(m.symbol) as { state: string } | undefined)?.state;
      if (s !== prev) state.run(m.symbol, s, Number(c.closureId), now);
    }
    const book = await program.account.auctionBook.fetchNullable(auctionBookPda(market));
    const last = book ? Number(book.nextId) : 0;
    const known = (db.prepare("select coalesce(max(id), 0) as id from auctions where market = ? and phase in (4, 5)").get(market.toBase58()) as { id: number }).id;
    for (let id = Math.max(1, Math.min(known + 1, last - 5)); id <= last; id++) {
      const a = await program.account.auction.fetchNullable(auctionPda(market, id));
      if (!a) continue;
      auction.run(
        market.toBase58(), m.symbol, id, AUCTION_KIND_NAME[a.kind] ?? String(a.kind), a.phase, Number(a.lot) / scale, Number(a.reserve) / 1e6,
        Number(a.pStar) / 1e6, Number(a.qPool) / scale, a.bidCount, Number(a.deadlines[3]), a.nav ? 1 : 0, now,
      );
    }
  }
}

async function pools(now: number) {
  const due = Number(meta.get("pools_at") ?? 0) + POOL_EVERY_SECS <= now;
  if (!due) return;
  const insert = db.prepare("insert or ignore into pools (venue, at, nav, free_cash, inventory_mark, claims_cost, losses_paid) values (?, ?, ?, ?, ?, ?, ?)");
  for (const venue of ["XNYS", "USBANK"]) {
    const p = await program.account.underwriterPool.fetchNullable(poolPda(venue));
    if (!p) continue;
    insert.run(venue, now, Number(poolNav(p)) / 1e6, Number(poolFreeCash(p)) / 1e6, Number(p.inventoryMark) / 1e6, Number(p.claimsCost) / 1e6, Number(p.lossesPaid) / 1e6);
  }
  meta.set("pools_at", String(now));
}

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  try {
    await markets(now);
    await pools(now);
    const n = await transactions();
    meta.set("indexed_at", String(now));
    if (n) log(`indexed ${n} transactions`);
  } catch (e) {
    log("indexer:", (e as Error).message);
  }
}

if (/indexer\.(ts|m?js)$/.test(process.argv[1] ?? "")) {
  log(`indexer → ${INDEX_DB}, every ${TICK_SECS}s`);
  await tick();
  setInterval(() => void tick(), TICK_SECS * 1000);
}
export { PublicKey };
