// Finity Lend (solana/lend): borrow against collateral and repay, a ~9.4 KB program on mainnet. On mainnet the
// collateral is xStocks (Token-2022, 8 decimals) and the loan is USDC (SPL Token, 6 decimals).
// Instruction encoders and account decoders for the layout in lend/src/lib.rs. No Anchor: the program is raw.

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";

import book from "./lend.json" with { type: "json" };

export type LendCluster = "mainnet" | "devnet";

/** "2022" = Token-2022, otherwise SPL Token. */
export type LendTokenProgram = "spl" | "2022";
/** One cluster's deployment, written by `pnpm lend seed`. Market order = the program's market index. */
export interface LendDeployment {
  markets: string;
  /** The loan token (USDC on mainnet; SPL Token, 6 decimals). */
  usdMint: string;
  /** Collateral mints in market order, by symbol. */
  mints: { symbol: string; mint: string; decimals: number; program: LendTokenProgram }[];
}
export interface LendBook {
  programId: string;
  clusters: Record<LendCluster, LendDeployment | null>;
}
export const LEND = book as LendBook;
export const LEND_PROGRAM_ID = new PublicKey(LEND.programId);

export const LEND_TAG = { MARKETS: 1, POSITION: 2 } as const;
export const MAX_MARKETS = 8;
const H_LEN = 80;
const MKT_LEN = 56;
export const MARKETS_LEN = H_LEN + MAX_MARKETS * MKT_LEN;
export const POSITION_LEN = 88;
export const LEND_MAX_PRICE_AGE_SECS = 20 * 60;
/** Decimals of the loan token and of prices (USD). */
export const LEND_DECIMALS = 6;
export const tokenProgramId = (p: LendTokenProgram | undefined) => (p === "2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
/** A market's posted price is per 10⁶ base units of its collateral: USD (6 decimals) per whole token, scaled. */
export const toPostedPrice = (usdPerToken: bigint, decimals: number) =>
  decimals >= 6 ? usdPerToken / 10n ** BigInt(decimals - 6) : usdPerToken * 10n ** BigInt(6 - decimals);
/** The USD price (6 decimals) of one whole token from its posted price. */
export const fromPostedPrice = (posted: bigint, decimals: number) =>
  decimals >= 6 ? posted * 10n ** BigInt(decimals - 6) : posted / 10n ** BigInt(6 - decimals);
export const VAULT_SEED = "vault";

export const LEND_IX = { INIT: 0, ADD_MARKET: 1, POST_PRICES: 2, BORROW: 3, REPAY: 4, CLOSE: 5, VAULT_ADMIN: 6 } as const;

export const LEND_ERRORS: Record<number, string> = {
  1: "Wrong account (owner, size, type, vault or duplicate)",
  2: "Missing signature, or not the markets authority / position owner",
  3: "Not available",
  4: "Amount or parameter out of range",
  5: "The price is updating: try again in a few minutes",
  7: "Over the borrowing limit for this collateral",
  9: "Account already initialised",
  10: "Cluster clock unavailable",
  11: "This position is within its limit",
};

export interface LendMarket {
  index: number;
  ticker: string;
  vault: PublicKey;
  /** USD, 6 decimals; 0 = borrowing paused. */
  price: bigint;
  maxLtvBps: number;
}
export interface LendMarkets {
  bump: number;
  authority: PublicKey;
  loanVault: PublicKey;
  priceAt: number;
  markets: LendMarket[];
}
export interface LendPosition {
  index: number;
  owner: PublicKey;
  markets: PublicKey;
  /** Collateral base units, 6 decimals. */
  collateral: bigint;
  /** Loan, USD 6 decimals. */
  debt: bigint;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

export function decodeMarkets(d: Uint8Array): LendMarkets | null {
  if (d.length !== MARKETS_LEN || d[0] !== LEND_TAG.MARKETS) return null;
  const v = view(d);
  const count = d[2]!;
  const markets: LendMarket[] = [];
  for (let i = 0; i < count; i++) {
    const b = H_LEN + i * MKT_LEN;
    markets.push({
      index: i,
      ticker: new TextDecoder().decode(d.slice(b, b + 8)).replace(/\0+$/, ""),
      vault: new PublicKey(d.slice(b + 8, b + 40)),
      price: v.getBigUint64(b + 40, true),
      maxLtvBps: v.getUint16(b + 48, true),
    });
  }
  return {
    bump: d[1]!,
    authority: new PublicKey(d.slice(8, 40)),
    loanVault: new PublicKey(d.slice(40, 72)),
    priceAt: Number(v.getBigInt64(72, true)),
    markets,
  };
}

export function decodePosition(d: Uint8Array): LendPosition | null {
  if (d.length !== POSITION_LEN || d[0] !== LEND_TAG.POSITION) return null;
  const v = view(d);
  return {
    index: d[1]!,
    owner: new PublicKey(d.slice(8, 40)),
    markets: new PublicKey(d.slice(40, 72)),
    collateral: v.getBigUint64(72, true),
    debt: v.getBigUint64(80, true),
  };
}

// ───────────── rules (mirror lib.rs, for previews) ─────────────

/** debt ≤ ltv × collateral × price (6-decimal fixed point). */
export const lendWithin = (debt: bigint, collateral: bigint, price: bigint, ltvBps: number) =>
  debt * 10_000n * 1_000_000n <= collateral * price * BigInt(ltvBps);
/** The most a position may owe at `price`. */
export const maxLoan = (collateral: bigint, price: bigint, ltvBps: number) => (collateral * price * BigInt(ltvBps)) / 10_000n / 1_000_000n;
export const priceFresh = (m: Pick<LendMarkets, "priceAt">, now = Math.floor(Date.now() / 1000)) =>
  m.priceAt > 0 && now - m.priceAt <= LEND_MAX_PRICE_AGE_SECS;

// ───────────── addresses ─────────────

export const vaultAuthority = (markets: PublicKey, programId = LEND_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED), markets.toBuffer()], programId);
/** A vault is the vault authority's associated token account for the mint (under the mint's token program). */
export const vaultFor = (markets: PublicKey, mint: PublicKey, programId = LEND_PROGRAM_ID, tokenProgram = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, vaultAuthority(markets, programId)[0], true, tokenProgram);
export const ataOf = (owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);

/** The deployment's public keys for one cluster, or null before `pnpm lend seed`. */
export function lendAddresses(cluster: LendCluster, programId = LEND_PROGRAM_ID) {
  const dep = LEND.clusters[cluster];
  if (!dep) return null;
  const markets = new PublicKey(dep.markets);
  const usdMint = new PublicKey(dep.usdMint);
  return {
    programId,
    markets,
    usdMint,
    vaultAuthority: vaultAuthority(markets, programId)[0],
    loanVault: vaultFor(markets, usdMint, programId),
    mints: dep.mints.map(({ symbol, mint, decimals, program }) => {
      const m = new PublicKey(mint);
      const tokenProgram = tokenProgramId(program);
      return { symbol, mint: m, decimals: decimals ?? LEND_DECIMALS, tokenProgram, vault: vaultFor(markets, m, programId, tokenProgram) };
    }),
  };
}
export type LendAddresses = NonNullable<ReturnType<typeof lendAddresses>>;

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
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts);
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
const ix = (programId: PublicKey, keys: ReturnType<typeof meta>[], data: Buffer) => new TransactionInstruction({ programId, keys, data });

export const tickerBytes = (t: string) => {
  const b = new Uint8Array(8);
  b.set(new TextEncoder().encode(t).slice(0, 8));
  return b;
};

/** The System Program call that creates a program-owned account (the new account must sign). */
export async function createProgramAccountIx(conn: Connection, payer: PublicKey, account: PublicKey, space: number, programId = LEND_PROGRAM_ID) {
  const lamports = await conn.getMinimumBalanceForRentExemption(space);
  return SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: account, lamports, space, programId });
}

/** Accounts of borrow / repay for `owner` in market `index`, using the owner's associated token accounts: …, the
 *  collateral and loan mints, SPL Token, and Token-2022 when the collateral uses it. */
function positionKeys(a: LendAddresses, position: PublicKey, positionSigns: boolean, owner: PublicKey, index: number) {
  const m = a.mints[index];
  if (!m) throw new Error(`no market ${index}`);
  return [
    meta(position, positionSigns, true),
    meta(a.markets, false, false),
    meta(owner, true, false),
    meta(ataOf(owner, m.mint, m.tokenProgram), false, true),
    meta(m.vault, false, true),
    meta(ataOf(owner, a.usdMint), false, true),
    meta(a.loanVault, false, true),
    meta(a.vaultAuthority, false, false),
    meta(m.mint, false, false),
    meta(a.usdMint, false, false),
    meta(TOKEN_PROGRAM_ID, false, false),
    ...(m.tokenProgram.equals(TOKEN_PROGRAM_ID) ? [] : [meta(m.tokenProgram, false, false)]),
  ];
}

export const lendIx = {
  init: (markets: PublicKey, authority: PublicKey, loanVault: PublicKey, bump: number, pid = LEND_PROGRAM_ID) =>
    ix(pid, [meta(markets, true, true), meta(authority, true, false), meta(loanVault, false, false)], cat(Uint8Array.of(LEND_IX.INIT, bump))),
  addMarket: (markets: PublicKey, authority: PublicKey, vault: PublicKey, ticker: string, maxLtvBps: number, pid = LEND_PROGRAM_ID) =>
    ix(pid, [meta(markets, false, true), meta(authority, true, false), meta(vault, false, false)], cat(Uint8Array.of(LEND_IX.ADD_MARKET), tickerBytes(ticker), u16(maxLtvBps))),
  /** One price per market, in market order. */
  postPrices: (markets: PublicKey, authority: PublicKey, prices: bigint[], pid = LEND_PROGRAM_ID) =>
    ix(pid, [meta(markets, false, true), meta(authority, true, false)], cat(Uint8Array.of(LEND_IX.POST_PRICES), ...prices.map(u64))),
  /** Locks `collateral` more and borrows `loan` more. `open` = the position account is new (it must sign). */
  borrow: (a: LendAddresses, position: PublicKey, owner: PublicKey, index: number, collateral: bigint, loan: bigint, open: boolean) =>
    ix(a.programId, positionKeys(a, position, open, owner, index), cat(Uint8Array.of(LEND_IX.BORROW, index), u64(collateral), u64(loan))),
  /** Pays `amount` back; paying the whole loan returns all the collateral. */
  repay: (a: LendAddresses, position: PublicKey, owner: PublicKey, index: number, amount: bigint) =>
    ix(a.programId, positionKeys(a, position, false, owner, index), cat(Uint8Array.of(LEND_IX.REPAY), u64(amount))),
  close: (account: PublicKey, to: PublicKey, pid = LEND_PROGRAM_ID) => ix(pid, [meta(account, false, true), meta(to, true, true)], Buffer.of(LEND_IX.CLOSE)),
  /** Teardown build only. op 0: move `amount` from `vault` to `dest`; op 1: close `vault`, rent to the authority.
   *  `mint` and `tokenProgram` are the vault's. */
  vaultAdmin: (a: LendAddresses, authority: PublicKey, vault: PublicKey, dest: PublicKey, op: 0 | 1, amount: bigint, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) =>
    ix(
      a.programId,
      [
        meta(a.markets, false, false),
        meta(authority, true, true),
        meta(vault, false, true),
        meta(dest, false, true),
        meta(a.vaultAuthority, false, false),
        meta(tokenProgram, false, false),
        meta(mint, false, false),
      ],
      cat(Uint8Array.of(LEND_IX.VAULT_ADMIN, op), u64(amount)),
    ),
  /** Creates `owner`'s associated token account for `mint` if missing (paid by `payer`). */
  ensureAta: (payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) =>
    createAssociatedTokenAccountIdempotentInstruction(payer, ataOf(owner, mint, tokenProgram), owner, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
};

/** Every position of `owner` (or all positions). */
export async function fetchPositions(conn: Connection, owner?: PublicKey, programId = LEND_PROGRAM_ID) {
  const accounts = await conn.getProgramAccounts(programId, {
    filters: [
      { dataSize: POSITION_LEN },
      { memcmp: { offset: 0, bytes: "3" /* base58 of [2] */ } },
      ...(owner ? [{ memcmp: { offset: 8, bytes: owner.toBase58() } }] : []),
    ],
  });
  return accounts.flatMap(({ pubkey, account }) => {
    const p = decodePosition(account.data);
    return p ? [{ pubkey, ...p }] : [];
  });
}

export async function fetchMarketsAccount(conn: Connection, markets: PublicKey) {
  const info = await conn.getAccountInfo(markets);
  return info ? decodeMarkets(info.data) : null;
}

/** The program error code in a failed transaction's message, as text. */
export function lendErrorText(e: unknown): string | null {
  const m = String((e as Error)?.message ?? e).match(/custom program error: 0x([0-9a-f]+)/i);
  return m?.[1] ? LEND_ERRORS[parseInt(m[1], 16)] ?? null : null;
}
