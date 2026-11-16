// Finity V2 (solana/v2): the Asset Clock and the Bell Check as a ~6.6 KB program on mainnet.
// Instruction encoders and account decoders for the layout in v2/src/lib.rs. No Anchor: the program is raw.

import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";

import v2 from "./v2.json" with { type: "json" };

export interface V2Deployment {
  programId: string;
  /** Market accounts by symbol, per cluster. */
  markets: Record<"mainnet" | "devnet", Record<string, string>>;
}
export const V2 = v2 as V2Deployment;
export const V2_PROGRAM_ID = new PublicKey(V2.programId);

/** Markets and positions are both 88 bytes; byte 0 tells them apart. */
export const V2_ACC_LEN = 88;
export const V2_TAG = { MARKET: 1, POSITION: 2 } as const;
export const V2_STATE = { OPEN: 0, EXTENDED: 1, CLOSED: 2, HALTED: 3, REOPEN: 4 } as const;
export const V2_STATE_NAMES = ["open", "extended", "closed", "halted", "reopen"] as const;
export type V2StateName = (typeof V2_STATE_NAMES)[number];
export const V2_BELL_WINDOW_SECS = 2 * 3600;
export const V2_MAX_PRICE_AGE_SECS = 300;
export const V2_ERRORS: Record<number, string> = {
  1: "Wrong account (owner, size, type or duplicate)",
  2: "Missing signature, or not the market authority / position owner",
  3: "Unknown instruction or wrong argument length",
  4: "Parameters out of range",
  5: "The price is stale: wait for the keeper's next update",
  6: "The market is closed: no new debt until it reopens",
  7: "Over the LTV limit that applies now",
  8: "Not in the Bell window yet",
  9: "Account already initialised",
  10: "Cluster clock unavailable",
};

export interface V2Market {
  state: V2StateName;
  maxLtvBps: number;
  safeLtvBps: number;
  authority: PublicKey;
  ticker: string;
  /** USD, 6 decimals. */
  price: bigint;
  priceAt: number;
  nextClose: number;
  nextReopen: number;
  closureId: number;
}

export interface V2Position {
  flagged: boolean;
  owner: PublicKey;
  market: PublicKey;
  /** Base units, 6 decimals. */
  collateral: bigint;
  /** USD, 6 decimals. */
  debt: bigint;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

export function decodeV2Market(d: Uint8Array): V2Market | null {
  if (d.length !== V2_ACC_LEN || d[0] !== V2_TAG.MARKET) return null;
  const v = view(d);
  return {
    state: V2_STATE_NAMES[d[1] ?? 2] ?? "closed",
    maxLtvBps: v.getUint16(2, true),
    safeLtvBps: v.getUint16(4, true),
    authority: new PublicKey(d.slice(8, 40)),
    ticker: new TextDecoder().decode(d.slice(40, 48)).replace(/\0+$/, ""),
    price: v.getBigUint64(48, true),
    priceAt: Number(v.getBigInt64(56, true)),
    nextClose: Number(v.getBigInt64(64, true)),
    nextReopen: Number(v.getBigInt64(72, true)),
    closureId: v.getUint32(80, true),
  };
}

export function decodeV2Position(d: Uint8Array): V2Position | null {
  if (d.length !== V2_ACC_LEN || d[0] !== V2_TAG.POSITION) return null;
  const v = view(d);
  return {
    flagged: d[1] === 1,
    owner: new PublicKey(d.slice(8, 40)),
    market: new PublicKey(d.slice(40, 72)),
    collateral: v.getBigUint64(72, true),
    debt: v.getBigUint64(80, true),
  };
}

// ───────────── rules (mirror lib.rs, for previews) ─────────────

export function v2EffectiveState(m: Pick<V2Market, "state" | "nextClose">, now: number): V2StateName {
  return (m.state === "open" || m.state === "extended") && (m.nextClose === 0 || now >= m.nextClose) ? "closed" : m.state;
}
export const v2InBell = (nextClose: number, now: number) => nextClose > 0 && now >= nextClose - V2_BELL_WINDOW_SECS;
/** The LTV limit (bps) that applies now, or null when the market accepts no new risk. */
export function v2LimitBps(m: V2Market, now: number): number | null {
  const s = v2EffectiveState(m, now);
  if (s === "open") return v2InBell(m.nextClose, now) ? m.safeLtvBps : m.maxLtvBps;
  return s === "extended" ? m.safeLtvBps : null;
}
/** debt ≤ ltv × collateral × price (6-decimal fixed point). */
export const v2Within = (debt: bigint, collateral: bigint, price: bigint, ltvBps: number) =>
  debt * 10_000n * 1_000_000n <= collateral * price * BigInt(ltvBps);

// ───────────── instructions ─────────────

const u16 = (n: number) => {
  const b = new Uint8Array(2);
  view(b).setUint16(0, n, true);
  return b;
};
const u64 = (n: bigint | number) => {
  const b = new Uint8Array(8);
  view(b).setBigUint64(0, BigInt(n), true);
  return b;
};
const i64 = (n: bigint | number) => {
  const b = new Uint8Array(8);
  view(b).setBigInt64(0, BigInt(n), true);
  return b;
};
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts);
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
const ix = (programId: PublicKey, keys: ReturnType<typeof meta>[], data: Buffer) =>
  new TransactionInstruction({ programId, keys, data });

export const tickerBytes = (t: string) => {
  const b = new Uint8Array(8);
  b.set(new TextEncoder().encode(t).slice(0, 8));
  return b;
};

/** The System Program call that creates an 88-byte account owned by the program (the new account must sign). */
export async function createV2AccountIx(conn: Connection, payer: PublicKey, account: PublicKey, programId = V2_PROGRAM_ID) {
  const lamports = await conn.getMinimumBalanceForRentExemption(V2_ACC_LEN);
  return SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: account, lamports, space: V2_ACC_LEN, programId });
}

export const v2Ix = {
  initMarket: (market: PublicKey, authority: PublicKey, ticker: string, maxLtvBps: number, safeLtvBps: number, pid = V2_PROGRAM_ID) =>
    ix(pid, [meta(market, true, true), meta(authority, true, false)], cat(Uint8Array.of(0), tickerBytes(ticker), u16(maxLtvBps), u16(safeLtvBps))),
  updateClock: (market: PublicKey, authority: PublicKey, state: number, safeLtvBps: number, nextClose: number, nextReopen: number, pid = V2_PROGRAM_ID) =>
    ix(pid, [meta(market, false, true), meta(authority, true, false)], cat(Uint8Array.of(1, state), u16(safeLtvBps), i64(nextClose), i64(nextReopen))),
  postPrice: (market: PublicKey, authority: PublicKey, price: bigint, pid = V2_PROGRAM_ID) =>
    ix(pid, [meta(market, false, true), meta(authority, true, false)], cat(Uint8Array.of(2), u64(price))),
  openPosition: (position: PublicKey, market: PublicKey, owner: PublicKey, collateral: bigint, debt: bigint, pid = V2_PROGRAM_ID) =>
    ix(pid, [meta(position, true, true), meta(market, false, false), meta(owner, true, false)], cat(Uint8Array.of(3), u64(collateral), u64(debt))),
  adjustPosition: (position: PublicKey, market: PublicKey, owner: PublicKey, collateral: bigint, debt: bigint, pid = V2_PROGRAM_ID) =>
    ix(pid, [meta(position, false, true), meta(market, false, false), meta(owner, true, false)], cat(Uint8Array.of(4), u64(collateral), u64(debt))),
  bellCheck: (position: PublicKey, market: PublicKey, pid = V2_PROGRAM_ID) =>
    ix(pid, [meta(position, false, true), meta(market, false, false)], Buffer.of(5)),
  close: (account: PublicKey, to: PublicKey, pid = V2_PROGRAM_ID) =>
    ix(pid, [meta(account, false, true), meta(to, true, true)], Buffer.of(6)),
};

/** Every position of `owner` (or all positions), across markets. */
export async function fetchV2Positions(conn: Connection, owner?: PublicKey, programId = V2_PROGRAM_ID) {
  const accounts = await conn.getProgramAccounts(programId, {
    filters: [
      { dataSize: V2_ACC_LEN },
      { memcmp: { offset: 0, bytes: "3" /* base58 of [2] */ } },
      ...(owner ? [{ memcmp: { offset: 8, bytes: owner.toBase58() } }] : []),
    ],
  });
  return accounts.flatMap(({ pubkey, account }) => {
    const p = decodeV2Position(account.data);
    return p ? [{ pubkey, ...p }] : [];
  });
}

/** The program error code in a failed transaction's message, as text. */
export function v2ErrorText(e: unknown): string | null {
  const m = String((e as Error)?.message ?? e).match(/custom program error: 0x([0-9a-f]+)/i);
  return m?.[1] ? V2_ERRORS[parseInt(m[1], 16)] ?? null : null;
}
