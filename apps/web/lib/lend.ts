"use client";
/**
 * Finity Lend on Solana mainnet: markets, the lending pool, positions and wallet balances read through this app's
 * /api/rpc/mainnet proxy, and one sender for Lend transactions (the wallet signs; the app sends to mainnet itself,
 * so it works whatever network the wallet is set to).
 */
import { MARKETS } from "@finity/solana";
import {
  LEND_DECIMALS,
  ataOf,
  fromPostedPrice,
  decodeMarkets,
  fetchPositions,
  lendAddresses,
  lendErrorText,
  LEND_ERRORS,
  maxLoan,
  priceFresh,
  type LendCluster,
} from "@finity/solana/lend";
import { useWallet } from "@solana/wallet-adapter-react";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { logActivity } from "./activity";
import type { ActivityNote } from "./solana";

/** "devnet" only for rehearsals (NEXT_PUBLIC_LEND_CLUSTER=devnet with the server's LEND_RPC_URL on devnet). */
export const LEND_CLUSTER: LendCluster = process.env.NEXT_PUBLIC_LEND_CLUSTER === "devnet" ? "devnet" : "mainnet";
export const LEND_ADDR = lendAddresses(LEND_CLUSTER);
/** The loan token. */
export const LEND_LOAN = "USDC";
const ONE = 10 ** LEND_DECIMALS;
const ui = (raw: bigint) => Number(raw) / ONE;

export const lendExplorer = (a: string, kind: "address" | "tx" = "address") =>
  `https://explorer.solana.com/${kind}/${a}${LEND_CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;

let conn: Connection | null = null;
/** One connection for every Lend read and send (the browser's goes through the server proxy). */
export function lendConn(): Connection {
  if (conn) return conn;
  const url =
    process.env.NEXT_PUBLIC_LEND_RPC_URL ||
    (typeof window === "undefined"
      ? LEND_CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com"
      : `${window.location.origin}/api/rpc/mainnet`);
  conn = new Connection(url, "confirmed");
  return conn;
}

export type LendMarketView = {
  index: number;
  /** The token's ticker, e.g. AAPLx. */
  symbol: string;
  /** The stock's ticker, e.g. AAPL (logos, the market clock). */
  base: string;
  name: string;
  kind: "Stock" | "Treasury fund";
  mint: PublicKey;
  decimals: number;
  tokenProgram: PublicKey;
  vault: PublicKey;
  /** USD per token. */
  price: number;
  /** As posted: USD (6 decimals) per 10⁶ base units, what the program's limit uses. */
  priceRaw: bigint;
  maxLtv: number;
  maxLtvBps: number;
  /** No price right now (market closed or the price is updating): borrowing waits, repaying works. */
  paused: boolean;
  collateral: number;
  collateralValue: number;
};

export type LendPoolView = {
  /** Loan money in the pool's vault, ready to borrow. */
  cash: number;
  /** Owed by borrowers. */
  lent: number;
  /** cash + lent. */
  supplied: number;
  utilisation: number;
  collateralValue: number;
  loans: number;
  /** Unix seconds of the last price update (0 = never). */
  priceAt: number;
  fresh: boolean;
};

/** Token account amount (u64 at byte 64), 0 when the account is missing. */
const tokenAmount = (data: Uint8Array | undefined) =>
  data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true) : 0n;

export function useLendMarkets() {
  return useQuery({
    queryKey: ["lend-markets"],
    refetchInterval: 20_000,
    queryFn: async (): Promise<{ markets: LendMarketView[]; pool: LendPoolView } | null> => {
      const a = LEND_ADDR;
      if (!a) return null;
      const c = lendConn();
      const [infos, positions] = await Promise.all([
        c.getMultipleAccountsInfo([a.markets, a.loanVault, ...a.mints.map((m) => m.vault)]),
        fetchPositions(c),
      ]);
      const mk = infos[0] ? decodeMarkets(infos[0].data) : null;
      if (!mk) return null;
      const fresh = priceFresh(mk);
      const markets = mk.markets.map((m): LendMarketView => {
        const book = a.mints[m.index];
        const base = m.ticker.replace(/x$/, "");
        const spec = MARKETS.find((s) => s.symbol === base);
        const decimals = book?.decimals ?? LEND_DECIMALS;
        const collateral = Number(tokenAmount(infos[2 + m.index]?.data)) / 10 ** decimals;
        const price = ui(fromPostedPrice(m.price, decimals));
        return {
          index: m.index,
          symbol: m.ticker,
          base,
          name: spec?.name ?? m.ticker,
          kind: spec && !spec.marketHours ? "Treasury fund" : "Stock",
          mint: book?.mint ?? PublicKey.default,
          decimals,
          tokenProgram: book?.tokenProgram ?? PublicKey.default,
          vault: m.vault,
          price,
          priceRaw: m.price,
          maxLtv: m.maxLtvBps / 10_000,
          maxLtvBps: m.maxLtvBps,
          paused: m.price === 0n || !fresh,
          collateral,
          collateralValue: collateral * price,
        };
      });
      const mine = positions.filter((p) => p.markets.equals(a.markets));
      const cash = ui(tokenAmount(infos[1]?.data));
      const lent = ui(mine.reduce((s, p) => s + p.debt, 0n));
      return {
        markets,
        pool: {
          cash,
          lent,
          supplied: cash + lent,
          utilisation: cash + lent > 0 ? lent / (cash + lent) : 0,
          collateralValue: markets.reduce((s, m) => s + m.collateralValue, 0),
          loans: mine.filter((p) => p.debt > 0n).length,
          priceAt: mk.priceAt,
          fresh,
        },
      };
    },
  });
}

export type LendLoan = {
  key: PublicKey;
  index: number;
  market: LendMarketView;
  collateralRaw: bigint;
  debtRaw: bigint;
  collateral: number;
  debt: number;
  value: number;
  ltv: number;
  /** More that can be borrowed now (0 while paused). */
  canBorrow: number;
};

/** The connected wallet's positions, joined with their markets. */
export function useLendLoans(markets: LendMarketView[] | undefined) {
  const { publicKey } = useWallet();
  const q = useQuery({
    queryKey: ["lend-positions", publicKey?.toBase58()],
    enabled: !!publicKey && !!LEND_ADDR,
    refetchInterval: 30_000,
    queryFn: async () => (await fetchPositions(lendConn(), publicKey!)).filter((p) => p.markets.equals(LEND_ADDR!.markets)),
  });
  const loans: LendLoan[] = (q.data ?? []).flatMap((p) => {
    const m = markets?.find((x) => x.index === p.index);
    if (!m) return [];
    const collateral = Number(p.collateral) / 10 ** m.decimals;
    const value = collateral * m.price;
    const cap = m.paused ? 0 : ui(maxLoan(p.collateral, m.priceRaw, m.maxLtvBps));
    return [
      {
        key: p.pubkey,
        index: p.index,
        market: m,
        collateralRaw: p.collateral,
        debtRaw: p.debt,
        collateral,
        debt: ui(p.debt),
        value,
        ltv: value > 0 ? ui(p.debt) / value : 0,
        canBorrow: Math.max(0, cap - ui(p.debt)),
      },
    ];
  });
  return { loans, isLoading: q.isLoading && !!publicKey };
}

/** SOL and Lend token balances of the connected wallet: raw units by symbol (LEND_LOAN for the loan token). */
export function useLendWallet() {
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["lend-wallet", publicKey?.toBase58()],
    enabled: !!publicKey && !!LEND_ADDR,
    refetchInterval: 20_000,
    queryFn: async () => {
      const a = LEND_ADDR!;
      const toks = [{ symbol: LEND_LOAN, mint: a.usdMint, decimals: LEND_DECIMALS, tokenProgram: undefined as PublicKey | undefined }, ...a.mints];
      const c = lendConn();
      const [sol, infos] = await Promise.all([
        c.getBalance(publicKey!),
        c.getMultipleAccountsInfo(toks.map((t) => ataOf(publicKey!, t.mint, t.tokenProgram))),
      ]);
      const raw: Record<string, bigint> = {};
      const dec: Record<string, number> = {};
      toks.forEach((t, i) => {
        raw[t.symbol] = tokenAmount(infos[i]?.data);
        dec[t.symbol] = t.decimals;
      });
      return { sol: sol / 1e9, raw, ui: (s: string) => Number(raw[s] ?? 0n) / 10 ** (dec[s] ?? LEND_DECIMALS) };
    },
  });
}

/** Whether the connected wallet is the pool's lender (the server knows the address; the app never does). */
export function useIsLender() {
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["lend-lender", publicKey?.toBase58()],
    enabled: !!publicKey,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch("/api/lend/lender", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: publicKey!.toBase58() }) });
      return res.ok ? ((await res.json()) as { lender: boolean }).lender : false;
    },
  });
}

/** Waits for `sig` by polling its status (the relay has no websocket): resolves when confirmed, throws if it failed
 *  or the blockhash expired first. */
export async function confirmByPolling(c: Connection, sig: string, lastValidBlockHeight: number): Promise<void> {
  for (;;) {
    const [{ value }, height] = await Promise.all([c.getSignatureStatuses([sig]), c.getBlockHeight("confirmed")]);
    const st = value[0];
    if (st?.err) throw new Error(JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    if (height > lastValidBlockHeight) throw new Error("The transaction expired before it landed. Nothing was sent; try again.");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export function lendHumanError(e: unknown): string {
  const text = e instanceof Error ? `${e.message} ${JSON.stringify((e as { logs?: string[] }).logs ?? "")}` : String(e);
  const known = lendErrorText(e) ?? LEND_ERRORS[Number(/"Custom":(\d+)/.exec(text)?.[1] ?? NaN)];
  if (known) return `${known}.`;
  if (/User rejected|rejected the request/i.test(text)) return "You rejected the request in your wallet.";
  if (/insufficient lamports|insufficient funds for (rent|fee)|Attempt to debit an account but found no record/i.test(text))
    return "Not enough SOL in your wallet for the network fee and account deposit.";
  if (/insufficient funds/i.test(text)) return "Not enough tokens in your wallet for this.";
  if (/429|Too many requests|rate limited/i.test(text)) return "The network is busy. Try again in a few seconds.";
  return e instanceof Error ? e.message : String(e);
}

/** Signs with the wallet and sends to Lend's network; returns the signature once confirmed. */
export function useLendSend() {
  const { publicKey, signTransaction } = useWallet();
  const qc = useQueryClient();
  return async (
    ixs: TransactionInstruction[] | Transaction,
    signers: Keypair[] = [],
    onStatus?: (s: string) => void,
    activity?: ActivityNote,
  ): Promise<string> => {
    if (!publicKey || !signTransaction) throw new Error("Connect a wallet first.");
    const c = lendConn();
    let tx: Transaction;
    let blockhash: string;
    let lastValidBlockHeight: number;
    if (ixs instanceof Transaction) {
      // Already built (and possibly partly signed): keep its blockhash.
      tx = ixs;
      blockhash = tx.recentBlockhash!;
      lastValidBlockHeight = tx.lastValidBlockHeight ?? (await c.getLatestBlockhash("confirmed")).lastValidBlockHeight;
    } else {
      ({ blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed"));
      tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 }),
        ...ixs,
      );
      if (signers.length) tx.partialSign(...signers);
    }
    onStatus?.("Confirm in wallet…");
    const signed = await signTransaction(tx);
    onStatus?.("Confirming…");
    const sig = await c.sendRawTransaction(signed.serialize());
    await confirmByPolling(c, sig, lastValidBlockHeight);
    if (activity) logActivity(publicKey.toBase58(), { ...activity, sig, when: Date.now(), net: "lend" });
    await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("lend-") });
    return sig;
  };
}
