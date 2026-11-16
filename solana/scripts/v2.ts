// Finity V2 operations: create markets, run the mainnet keeper, show status, demo a position, reclaim rent.
//
//   pnpm v2 seed     [--cluster mainnet|devnet] [--markets AAPL,MSFT,...]   create + init markets (pays rent)
//   pnpm v2 keeper   [--cluster mainnet|devnet] [--once]                    mirror the devnet Asset Clock
//   pnpm v2 status   [--cluster mainnet|devnet]
//   pnpm v2 demo     [--cluster devnet]                                     open, Bell-check and close a position
//   pnpm v2 close-all [--cluster mainnet|devnet]                            close markets, rent back to the authority
//
// The keeper is the market authority. It reads the full program on devnet (clock state, next close and reopen,
// the oracle price, which there is 2-of-3 relayer-signed and checked on-chain, and the calibrated risk sets) and
// writes to V2 only what changed, in one transaction per tick, so mainnet fees stay at a few cents a day.
//
// Settings (env, or ~/.config/finity/env via the service unit):
//   V2_WALLET        authority keypair (default: ~/.config/finity/mainnet-authority.json on mainnet,
//                      SOLANA_WALLET or ~/.config/solana/id.json on devnet)
//   V2_RPC_URL       RPC for the V2 cluster (default: public endpoint of --cluster)
//   SOLANA_RPC_URL     devnet RPC the keeper reads the full program from (as for the other services)
//   V2_TICK_SECS     how often the keeper reads devnet (default 30; reads are free)
//   V2_PRICE_SECS    how often a live market's price is re-posted (default 240; the program accepts ≤ 300 s)
//   V2_CLOSED_PRICE_SECS  the same while closed, for display only (default 3600)
//   V2_MIN_BALANCE   the keeper stops writing below this many SOL (default 0.002)

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { MARKETS, clockPda, clockStateName, fetchMarkets, riskConfigPda, riskSetPda, safeLtvWad, safeRuleClosure } from "../client/index";
import {
  V2,
  V2_PROGRAM_ID,
  V2_STATE,
  createV2AccountIx,
  decodeV2Market,
  decodeV2Position,
  fetchV2Positions,
  v2ErrorText,
  v2Ix,
  type V2Market,
} from "../client/v2";
import { loadKeypair, log, setup } from "./env";

const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cluster = (opt("cluster") ?? "mainnet") as "mainnet" | "devnet";
if (cluster !== "mainnet" && cluster !== "devnet") throw new Error("--cluster must be mainnet or devnet");

const RPC = process.env.V2_RPC_URL || (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const WALLET =
  process.env.V2_WALLET ||
  (cluster === "mainnet" ? `${homedir()}/.config/finity/mainnet-authority.json` : process.env.SOLANA_WALLET || `${homedir()}/.config/solana/id.json`);
const TICK_SECS = Number(process.env.V2_TICK_SECS ?? 30);
const PRICE_SECS = Number(process.env.V2_PRICE_SECS ?? 240);
const CLOSED_PRICE_SECS = Number(process.env.V2_CLOSED_PRICE_SECS ?? 3600);
const MIN_BALANCE = Number(process.env.V2_MIN_BALANCE ?? 0.002);
/** The keeper does not forward a devnet price older than this (the full program's own freshness bound). */
const SOURCE_MAX_AGE = 180;

const conn = new Connection(RPC, "confirmed");
const ADDRESS_BOOK = join(dirname(fileURLToPath(import.meta.url)), "../client/v2.json");
const explorer = (a: string, kind = "address") => `https://explorer.solana.com/${kind}/${a}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  try {
    return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  } catch (e) {
    const why = v2ErrorText(e);
    throw why ? new Error(`${why} (${String((e as Error).message).split("\n")[0]})`) : e;
  }
}

async function balance(pk: PublicKey) {
  return (await conn.getBalance(pk)) / LAMPORTS_PER_SOL;
}

function marketAddresses(): Record<string, PublicKey> {
  return Object.fromEntries(Object.entries(V2.markets[cluster]).map(([s, a]) => [s, new PublicKey(a)]));
}

async function fetchV2Markets() {
  const book = marketAddresses();
  const symbols = Object.keys(book);
  const infos = await conn.getMultipleAccountsInfo(symbols.map((s) => book[s]));
  return symbols.flatMap((s, i) => {
    const m = infos[i] ? decodeV2Market(infos[i]!.data) : null;
    return m ? [{ symbol: s, address: book[s], market: m }] : [];
  });
}

// ───────────── seed ─────────────

async function seed() {
  const authority = loadKeypair(WALLET);
  const wanted = (opt("markets") ?? MARKETS.map((m) => m.symbol).join(",")).split(",").map((s) => s.trim().toUpperCase());
  const program = await conn.getAccountInfo(V2_PROGRAM_ID);
  if (!program?.executable) throw new Error(`V2 program ${V2_PROGRAM_ID.toBase58()} is not deployed on ${cluster}`);
  log(`authority ${authority.publicKey.toBase58()}: ${(await balance(authority.publicKey)).toFixed(6)} SOL`);
  const book = V2.markets[cluster];
  for (const symbol of wanted) {
    const spec = MARKETS.find((m) => m.symbol === symbol);
    if (!spec) throw new Error(`unknown market ${symbol}`);
    if (book[symbol]) {
      log(`${symbol}: already at ${book[symbol]}`);
      continue;
    }
    const account = Keypair.generate();
    const sig = await send(
      [
        await createV2AccountIx(conn, authority.publicKey, account.publicKey),
        v2Ix.initMarket(account.publicKey, authority.publicKey, symbol, spec.maxLtvBps, spec.closedLtvBps),
      ],
      [authority, account],
    );
    book[symbol] = account.publicKey.toBase58();
    // Saved after every market, so a failure part-way keeps what was created.
    writeFileSync(ADDRESS_BOOK, JSON.stringify(V2, null, 2) + "\n");
    log(`${symbol}: ${account.publicKey.toBase58()} ${explorer(sig, "tx")}`);
  }
  log(`done; ${(await balance(authority.publicKey)).toFixed(6)} SOL left. Address book: client/v2.json`);
}

// ───────────── keeper ─────────────

const STATE_OF: Record<string, number> = {
  regular: V2_STATE.OPEN,
  extended: V2_STATE.EXTENDED,
  closed: V2_STATE.CLOSED,
  halted: V2_STATE.HALTED,
  corpAction: V2_STATE.HALTED,
  reopen: V2_STATE.REOPEN,
};

interface Target {
  state: number;
  safeLtvBps: number;
  nextClose: number;
  nextReopen: number;
  /** USD, 6 decimals (0 when devnet has none), and its age in seconds on devnet. */
  price: bigint;
  priceAge: number;
}

/** What each V2 market should say, read from the full program on devnet. */
async function readDevnet(source: ReturnType<typeof setup>, setCache: Map<string, { at: number; v: unknown }>): Promise<Map<string, Target>> {
  const { program } = source;
  const now = Math.floor(Date.now() / 1000);
  const markets = await fetchMarkets(program);
  const clocks = await program.account.assetClock.fetchMultiple(markets.map((m) => clockPda(m.publicKey)));
  const cfg = await program.account.riskConfig.fetch(riskConfigPda());
  const out = new Map<string, Target>();
  for (const [i, { publicKey, account: m }] of markets.entries()) {
    const c = clocks[i];
    if (!c) continue;
    const name = clockStateName(c.state);
    const state = STATE_OF[name] ?? V2_STATE.CLOSED;
    const { type } = safeRuleClosure(c);
    const key = `${publicKey.toBase58()}:${type}`;
    let set = setCache.get(key);
    if (!set || Date.now() - set.at > 600_000) {
      set = { at: Date.now(), v: await program.account.riskSet.fetch(riskSetPda(publicKey, type)) };
      setCache.set(key, set);
    }
    const rs = set.v as Parameters<typeof safeLtvWad>[0];
    const safeLtvBps = Number(safeLtvWad(rs, cfg, m.maxLtvBps) / 10n ** 14n);
    // Live: the upcoming closure. In a closure: the current one (its close is past, its reopen ahead).
    const [nextClose, nextReopen] = c.reopenPending && state !== V2_STATE.OPEN && state !== V2_STATE.EXTENDED
      ? [Number(c.closeAt), Number(c.reopenAt)]
      : [Number(c.nextCloseAt), Number(c.nextReopenAt)];
    out.set(m.symbol, {
      state,
      safeLtvBps: Math.min(safeLtvBps, m.maxLtvBps),
      nextClose: Math.max(0, nextClose),
      nextReopen: nextReopen > nextClose ? nextReopen : 0,
      price: BigInt(m.price.toString()),
      priceAge: now - Number(m.priceUpdatedAt),
    });
  }
  return out;
}

function plan(authority: PublicKey, address: PublicKey, v2: V2Market, t: Target, now: number): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  const stateNow = ["open", "extended", "closed", "halted", "reopen"].indexOf(v2.state);
  if (stateNow !== t.state || v2.safeLtvBps !== t.safeLtvBps || v2.nextClose !== t.nextClose || v2.nextReopen !== t.nextReopen) {
    ixs.push(v2Ix.updateClock(address, authority, t.state, t.safeLtvBps, t.nextClose, t.nextReopen));
  }
  // Live markets need a price ≤ 300 s old to take new debt. Closed ones only show it, so hourly is enough.
  const live = t.state === V2_STATE.OPEN || t.state === V2_STATE.EXTENDED;
  const every = live ? PRICE_SECS : CLOSED_PRICE_SECS;
  // Forward only a fresh price to a live market; a closed one may show the last close (up to a day old).
  const usable = t.price > 0n && t.priceAge <= (live ? SOURCE_MAX_AGE : 86_400);
  if (usable && (now - v2.priceAt >= every || v2.price === 0n)) {
    ixs.push(v2Ix.postPrice(address, authority, t.price));
  }
  return ixs;
}

async function keeper() {
  const authority = loadKeypair(WALLET);
  const source = setup();
  const setCache = new Map<string, { at: number; v: unknown }>();
  const once = args.includes("--once");
  log(`V2 keeper on ${cluster} (${V2_PROGRAM_ID.toBase58()}), authority ${authority.publicKey.toBase58()}; source devnet program ${source.program.programId.toBase58()}`);
  for (;;) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [targets, v2] = await Promise.all([readDevnet(source, setCache), fetchV2Markets()]);
      const ixs = v2.flatMap(({ symbol, address, market }) => {
        if (!market.authority.equals(authority.publicKey)) return [];
        const t = targets.get(symbol);
        return t ? plan(authority.publicKey, address, market, t, now) : [];
      });
      if (ixs.length) {
        const sol = await balance(authority.publicKey);
        if (sol < MIN_BALANCE) {
          log(`balance ${sol.toFixed(6)} SOL is below V2_MIN_BALANCE (${MIN_BALANCE}); not writing. Top up ${authority.publicKey.toBase58()}.`);
        } else {
          // Up to 8 instructions per transaction keeps it well under the 1232-byte limit.
          for (let i = 0; i < ixs.length; i += 8) {
            const sig = await send(ixs.slice(i, i + 8), [authority]);
            log(`updated ${ixs.slice(i, i + 8).length} field(s): ${sig}`);
          }
        }
      }
    } catch (e) {
      log("tick failed:", (e as Error).message);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, TICK_SECS * 1000));
  }
}

// ───────────── status ─────────────

async function status() {
  const program = await conn.getAccountInfo(V2_PROGRAM_ID);
  console.log(`Finity V2 on ${cluster}: ${V2_PROGRAM_ID.toBase58()} ${program?.executable ? "deployed" : "NOT DEPLOYED"}`);
  const now = Math.floor(Date.now() / 1000);
  for (const { symbol, address, market: m } of await fetchV2Markets()) {
    const age = m.priceAt ? `${now - m.priceAt}s ago` : "never";
    const close = m.nextClose ? new Date(m.nextClose * 1000).toISOString() : "-";
    console.log(
      `${symbol.padEnd(6)} ${m.state.padEnd(8)} $${(Number(m.price) / 1e6).toFixed(2).padStart(9)} (${age})  max ${m.maxLtvBps / 100}%  safe ${m.safeLtvBps / 100}%  close ${close}  closure #${m.closureId}  ${address.toBase58()}`,
    );
  }
  const positions = await fetchV2Positions(conn);
  console.log(`${positions.length} position(s)${positions.filter((p) => p.flagged).length ? `, ${positions.filter((p) => p.flagged).length} flagged by the Bell` : ""}`);
}

// ───────────── demo (devnet) ─────────────

async function demo() {
  const owner = loadKeypair(WALLET);
  const v2 = await fetchV2Markets();
  const now = Math.floor(Date.now() / 1000);
  const live = v2.find(({ market: m }) => (m.state === "open" || m.state === "extended") && now - m.priceAt <= 300);
  const pick = live ?? v2[0];
  if (!pick) throw new Error("no V2 markets: run `pnpm v2 seed` first");
  const { symbol, address, market: m } = pick;
  const position = Keypair.generate();
  // Collateral only (no debt) works whatever the clock says; debt needs a live market.
  const coll = 10_000_000n;
  const debt = live ? (coll * m.price * BigInt(m.safeLtvBps)) / 10_000n / 1_000_000n / 2n : 0n;
  let sig = await send(
    [await createV2AccountIx(conn, owner.publicKey, position.publicKey), v2Ix.openPosition(position.publicKey, address, owner.publicKey, coll, debt)],
    [owner, position],
  );
  log(`opened ${symbol} position ${position.publicKey.toBase58()} (10 shares, $${Number(debt) / 1e6} debt): ${explorer(sig, "tx")}`);
  try {
    sig = await send([v2Ix.bellCheck(position.publicKey, address)], [owner]);
    const p = decodeV2Position((await conn.getAccountInfo(position.publicKey))!.data)!;
    log(`Bell check: ${p.flagged ? "flagged" : "safe"} ${explorer(sig, "tx")}`);
  } catch (e) {
    log(`Bell check: ${(e as Error).message}`);
  }
  if (!args.includes("--keep")) {
    sig = await send([v2Ix.close(position.publicKey, owner.publicKey)], [owner]);
    log(`closed it, rent returned: ${explorer(sig, "tx")}`);
  }
}

// ───────────── close-all ─────────────

async function closeAll() {
  const authority = loadKeypair(WALLET);
  const book = V2.markets[cluster];
  for (const { symbol, address, market } of await fetchV2Markets()) {
    if (!market.authority.equals(authority.publicKey)) continue;
    const sig = await send([v2Ix.close(address, authority.publicKey)], [authority]);
    delete book[symbol];
    writeFileSync(ADDRESS_BOOK, JSON.stringify(V2, null, 2) + "\n");
    log(`${symbol}: closed ${explorer(sig, "tx")}`);
  }
  log(`authority balance ${(await balance(authority.publicKey)).toFixed(6)} SOL`);
}

const commands: Record<string, () => Promise<void>> = { seed, keeper, status, demo, "close-all": closeAll };
if (!commands[cmd]) throw new Error(`unknown command ${cmd}; one of ${Object.keys(commands).join(", ")}`);
await commands[cmd]();
