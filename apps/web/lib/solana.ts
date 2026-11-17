"use client";
/**
 * Finity's Solana data layer: markets, positions, the senior vault and balances read straight from the program's
 * accounts (accrued client-side with the program's exact math), instruction builders for every user action,
 * and one transaction sender.
 */
import {
  BN,
  CLOSURE,
  CLOSURE_NAMES,
  DEVNET,
  borrowRule,
  clockPda,
  clockStateName,
  riskAccounts,
  riskComputeBudget,
  riskConfigPda,
  riskSetPda,
  safeLtvWad,
  venueOf,
  type ClockStateName,
  MARKETS,
  SHARE_DECIMALS,
  STOCK_DECIMALS,
  USDC_DECIMALS,
  accrued,
  configPda,
  finityProgram,
  debtOf,
  fetchMarkets,
  fetchPositions,
  fromUnits,
  idl,
  liquidityOf,
  positionPda,
  rates,
  seniorPda,
  sessionName,
  shareMintPda,
  sharesToAssets,
  toUnits,
  usdcVaultPda,
  vaultPda,
  type Lending,
  type MarketLike,
} from "@finity/solana";
import { AnchorProvider } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { logActivity } from "./activity";

export const USDC_MINT = new PublicKey(DEVNET.usdcMint || PublicKey.default);
export const SHARE_MINT = shareMintPda();
export const LOAN_SYMBOL = "USDC";

export type MarketState = "Open" | "Extended" | "Closed" | "Reopen" | "Halted" | "Corp. action";

const STATE_OF: Record<ClockStateName, MarketState> = {
  regular: "Open", extended: "Extended", closed: "Closed", reopen: "Reopen", halted: "Halted", corpAction: "Corp. action",
};

/** The market clock as the app shows it. Times are unix seconds (0 = unknown). */
export type ClockView = {
  stateName: ClockStateName;
  closureId: number;
  /** Closure in progress (reopen pending), else null. */
  current: { type: string; closeAt: number; reopenAt: number } | null;
  nextCloseAt: number;
  nextClosureType: string;
  nextReopenAt: number;
  bellWindowAt: number;
  bellAt: number;
  refPrice: number;
  openPrint: number;
  restrictedUntil: number;
};

export type Market = {
  key: PublicKey;
  mint: PublicKey;
  symbol: string;
  name: string;
  kind: "Stock" | "Treasury fund";
  marketHours: boolean;
  price: number;
  /** Price the limits value collateral at: inside a closure, min(live, close) (P4). */
  valuePrice: number;
  /** Seconds since the keeper last pushed the price. */
  priceAge: number;
  state: MarketState;
  maxLtv: number;
  closedLtv: number;
  /** The LTV new borrowing may reach right now, measured on today's debt (closure-safe rule included). */
  borrowLtv: number;
  /** "open": max LTV in the regular session before the Bell window; "safe": the closure's safe LTV on debt
   *  projected to the reopen; "paused": REOPEN or a corporate action. */
  rule: "open" | "safe" | "paused";
  /** Safe LTV and σ by closure type (1 overnight, 2 weekend, 3 holiday weekend). */
  safeLtvByType: Record<number, number>;
  sigmaByType: Record<number, number>;
  /** Closure the safe rule looks at, and its length in days. */
  ruleClosure: { type: number; label: string; days: number | null };
  clock: ClockView | null;
  liqThreshold: number;
  liqBonus: number;
  collateralTokens: number;
  /** USDC value of all collateral in the market. */
  collateralValue: number;
  /** Senior vault supply (interest included), borrows, and cash left to borrow, in USDC. */
  supplied: number;
  borrowed: number;
  liquidity: number;
  borrowCap: number;
  borrowApr: number;
  supplyApr: number;
  utilization: number;
  poolFees: number;
  treasuryFees: number;
  /** Raw account and accrued figures, for exact debt. */
  raw: MarketLike;
  lending: Lending;
};

export type Position = {
  key: PublicKey;
  market: Market;
  tokens: number;
  tokensRaw: BN;
  borrowShares: BN;
  debt: number;
  debtRaw: bigint;
  value: number;
  /** Debt over collateral value; 0 without debt. */
  ltv: number;
  /** Liquidation limit over debt; null without debt. */
  hf: number | null;
  /** Further USDC borrowable right now (limit and market liquidity). */
  canBorrow: number;
  liquidatable: boolean;
};

const STATE: Record<string, MarketState> = { open: "Open", closed: "Closed", halted: "Halted" };
const u = (x: bigint) => Number(x) / 1e6;

/** A read-only wallet for fetching accounts before anyone connects. */
const READONLY = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("Connect a wallet first.")),
  signAllTransactions: () => Promise.reject(new Error("Connect a wallet first.")),
};

export function useProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(
    () => finityProgram(new AnchorProvider(connection, (wallet ?? READONLY) as never, { commitment: "confirmed" })),
    [connection, wallet],
  );
}

export function useMarkets() {
  const program = useProgram();
  const q = useQuery({
    queryKey: ["markets"],
    refetchInterval: 15_000,
    queryFn: async (): Promise<Market[]> => {
      const now = Math.floor(Date.now() / 1000);
      const rows = await fetchMarkets(program);
      const order = MARKETS.map((s) => s.symbol);
      const types = [CLOSURE.OVERNIGHT, CLOSURE.WEEKEND, CLOSURE.HOLIDAY_WEEKEND];
      const [clocks, sets, cfg] = await Promise.all([
        program.account.assetClock.fetchMultiple(rows.map((r) => clockPda(r.publicKey))),
        program.account.riskSet.fetchMultiple(rows.flatMap((r) => types.map((t) => riskSetPda(r.publicKey, t)))),
        program.account.riskConfig.fetchNullable(riskConfigPda()),
      ]);
      return rows
        .map(({ publicKey, account: a }, idx) => {
          const spec = MARKETS.find((s) => s.symbol === a.symbol);
          const c = clocks[idx];
          const state: MarketState = c ? STATE_OF[clockStateName(c.state)] : (STATE[sessionName(a.session)] ?? "Closed");
          const safeLtvByType: Record<number, number> = {};
          const sigmaByType: Record<number, number> = {};
          types.forEach((t, k) => {
            const set = sets[idx * 3 + k];
            if (!set || !cfg) return;
            safeLtvByType[t] = Number(safeLtvWad({ n: set.n, sigma: set.sigma, dividend: set.dividend, zTail: set.zTail }, cfg, a.maxLtvBps)) / 1e18;
            sigmaByType[t] = Number(set.sigma.toString()) / 1e18;
          });
          const price = fromUnits(a.price);
          const collateralTokens = fromUnits(a.totalCollateral, a.collateralDecimals);
          const l = accrued(a, now);
          const r = rates(a, l);
          const br = c ? borrowRule(c, now) : null;
          const rule: Market["rule"] = !br ? "open" : br.paused ? "paused" : br.open ? "open" : "safe";
          const ruleType = br?.closure.type ?? CLOSURE.WEEKEND;
          const days = br?.closure.days ?? null;
          const safe = safeLtvByType[ruleType] ?? a.closedLtvBps / 10_000;
          // (debt + x) × (1 + r × days/365) ≤ value × safe  ⇒  the limit on today's debt is safe / (1 + r × days/365).
          const borrowLtv = rule === "paused" ? 0 : rule === "open" ? a.maxLtvBps / 10_000 : days ? safe / (1 + (r.borrowApr * days) / 365) : 0;
          const clock: ClockView | null = c
            ? {
                stateName: clockStateName(c.state),
                closureId: Number(c.closureId.toString()),
                current: c.reopenPending
                  ? { type: CLOSURE_NAMES[c.closureType] ?? "—", closeAt: Number(c.closeAt), reopenAt: Number(c.reopenAt) }
                  : null,
                nextCloseAt: Number(c.nextCloseAt),
                nextClosureType: CLOSURE_NAMES[c.nextClosureType] ?? "—",
                nextReopenAt: Number(c.nextReopenAt),
                bellWindowAt: Number(c.bellWindowAt),
                bellAt: Number(c.bellAt),
                refPrice: fromUnits(c.refPrice),
                openPrint: fromUnits(c.openPrint),
                restrictedUntil: Number(c.restrictionUntil) > now ? Number(c.restrictionUntil) : 0,
              }
            : null;
          return {
            key: publicKey,
            mint: a.collateralMint,
            symbol: a.symbol,
            name: spec?.name ?? a.symbol,
            kind: spec?.marketHours === false ? ("Treasury fund" as const) : ("Stock" as const),
            marketHours: spec?.marketHours ?? true,
            price,
            valuePrice: clock?.current && clock.refPrice > 0 ? Math.min(price, clock.refPrice) : price,
            priceAge: Math.max(0, now - Number(a.priceUpdatedAt.toString())),
            state,
            maxLtv: a.maxLtvBps / 10_000,
            closedLtv: a.closedLtvBps / 10_000,
            borrowLtv,
            rule,
            safeLtvByType,
            sigmaByType,
            ruleClosure: { type: ruleType, label: CLOSURE_NAMES[ruleType] ?? "—", days },
            clock,
            liqThreshold: a.liqThresholdBps / 10_000,
            liqBonus: a.liqBonusBps / 10_000,
            collateralTokens,
            collateralValue: collateralTokens * price,
            supplied: u(l.supply),
            borrowed: u(l.borrow),
            liquidity: u(liquidityOf(l)),
            borrowCap: fromUnits(a.borrowCap),
            borrowApr: r.borrowApr,
            supplyApr: r.supplyApr,
            utilization: r.utilization,
            poolFees: u(l.poolFees),
            treasuryFees: u(l.treasuryFees),
            raw: a,
            lending: l,
          };
        })
        .sort((x, y) => order.indexOf(x.symbol) - order.indexOf(y.symbol));
    },
  });
  return { markets: q.data ?? [], isLoading: q.isLoading, error: q.error };
}

export function positionOf(key: PublicKey, m: Market, collateral: BN, borrowShares: BN): Position {
  const tokens = fromUnits(collateral, STOCK_DECIMALS);
  const debtRaw = debtOf(borrowShares, m.lending);
  const debt = u(debtRaw);
  const value = tokens * m.price;
  const liqLimit = value * m.liqThreshold;
  const ruleValue = tokens * m.valuePrice;
  return {
    key,
    market: m,
    tokens,
    tokensRaw: collateral,
    borrowShares,
    debt,
    debtRaw,
    value,
    ltv: value > 0 && debt > 0 ? debt / value : 0,
    hf: debt > 0 ? liqLimit / debt : null,
    canBorrow: Math.max(0, Math.min(ruleValue * m.borrowLtv - debt, m.liquidity, m.borrowCap - m.borrowed)),
    liquidatable: debt > 0 && debt > liqLimit,
  };
}

export function usePositions(markets: Market[]) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const q = useQuery({
    queryKey: ["positions", publicKey?.toBase58()],
    enabled: !!publicKey && markets.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      // Position layout: 8-byte discriminator, then the owner.
      const rows = await fetchPositions(program, publicKey!);
      return rows.map((r) => ({ key: r.publicKey, market: r.account.market, collateral: r.account.collateral, shares: r.account.borrowShares }));
    },
  });
  const positions = (q.data ?? [])
    .map((r) => {
      const m = markets.find((x) => x.key.equals(r.market));
      return m ? positionOf(r.key, m, r.collateral, r.shares) : null;
    })
    .filter((p): p is Position => !!p && (p.tokens > 0 || p.debt > 0));
  return { positions, isLoading: q.isLoading && !!publicKey };
}

/** Token balances by mint (base58) plus SOL, for the connected wallet. */
export function useBalances() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["balances", publicKey?.toBase58()],
    enabled: !!publicKey,
    refetchInterval: 15_000,
    queryFn: async () => {
      const [sol, tokens] = await Promise.all([
        connection.getBalance(publicKey!),
        connection.getParsedTokenAccountsByOwner(publicKey!, { programId: TOKEN_PROGRAM_ID }),
      ]);
      const byMint: Record<string, number> = {};
      const rawByMint: Record<string, bigint> = {};
      for (const t of tokens.value) {
        const info = t.account.data.parsed.info as { mint: string; tokenAmount: { uiAmount: number | null; amount: string } };
        byMint[info.mint] = (byMint[info.mint] ?? 0) + (info.tokenAmount.uiAmount ?? 0);
        rawByMint[info.mint] = (rawByMint[info.mint] ?? 0n) + BigInt(info.tokenAmount.amount);
      }
      return { sol: sol / 1e9, byMint, rawByMint };
    },
  });
}

// ── Senior vault ─────────────────────────────────────────────────────────────────────────────────

export type VaultView = {
  marketKeys: PublicKey[];
  /** idle + Σ accrued market supply, in USDC. */
  tvl: number;
  totalAssetsRaw: bigint;
  shareSupply: bigint;
  idle: number;
  borrowed: number;
  /** Payable right now: idle + Σ min(liquidity, supply) over the withdraw queue. */
  available: number;
  /** Senior APY: supply-weighted senior rate of every market. */
  apy: number;
  sharePrice: number;
  queueLength: number;
  pendingShares: bigint;
  /** First-loss cushion so far: the pool and treasury interest receivables. */
  poolFees: number;
  treasuryFees: number;
};

export function useSeniorVault(markets: Market[]) {
  const program = useProgram();
  const { connection } = useConnection();
  const q = useQuery({
    queryKey: ["senior", markets.map((m) => m.supplied).join()],
    enabled: markets.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<VaultView> => {
      const [v, mint] = await Promise.all([program.account.seniorVault.fetch(seniorPda()), connection.getTokenSupply(SHARE_MINT)]);
      const byKey = new Map(markets.map((m) => [m.key.toBase58(), m]));
      const vm = v.markets.map((k) => byKey.get(k.toBase58())).filter((m): m is Market => !!m);
      const supplied = vm.reduce((a, m) => a + m.lending.supply, 0n);
      const idle = BigInt(v.idle.toString());
      const totalAssetsRaw = idle + supplied;
      const shareSupply = BigInt(mint.value.amount);
      const available = v.withdrawQueue.reduce((a, i) => {
        const m = vm[i];
        if (!m) return a;
        const liq = liquidityOf(m.lending);
        return a + (liq < m.lending.supply ? liq : m.lending.supply);
      }, idle);
      const tvl = u(totalAssetsRaw);
      return {
        marketKeys: v.markets,
        tvl,
        totalAssetsRaw,
        shareSupply,
        idle: u(idle),
        borrowed: vm.reduce((a, m) => a + m.borrowed, 0),
        available: u(available),
        apy: tvl > 0 ? vm.reduce((a, m) => a + m.supplied * m.supplyApr, 0) / tvl : 0,
        sharePrice: Number(sharesToAssets(10n ** BigInt(SHARE_DECIMALS), totalAssetsRaw, shareSupply)) / 1e6,
        queueLength: Number(v.nextRequestId.sub(v.queueHead).toString()),
        pendingShares: BigInt(v.pendingRedeemShares.toString()),
        poolFees: vm.reduce((a, m) => a + m.poolFees, 0),
        treasuryFees: vm.reduce((a, m) => a + m.treasuryFees, 0),
      };
    },
  });
  return { vault: q.data, error: q.error, isLoading: q.isLoading };
}


// ── Instructions ─────────────────────────────────────────────────────────────────────────────────

type Program = ReturnType<typeof useProgram>;
const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
const ensureAta = (payer: PublicKey, mint: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, payer), payer, mint);
const tokenAccounts = { tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
const ataAccounts = { associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID };

export const ix = {
  faucet: async (program: Program, owner: PublicKey, mint: PublicKey, amount: number, decimals: number) => [
    await program.methods
      .faucet(toUnits(amount, decimals))
      .accountsPartial({ user: owner, config: configPda(), mint, userToken: ata(mint, owner), ...tokenAccounts, ...ataAccounts })
      .instruction(),
  ],
  deposit: async (program: Program, owner: PublicKey, m: Market, amount: BN) => [
    ensureAta(owner, m.mint),
    await program.methods
      .deposit(amount)
      .accountsPartial({ owner, market: m.key, position: positionPda(m.key, owner), ownerCollateral: ata(m.mint, owner), vault: vaultPda(m.key), ...tokenAccounts })
      .instruction(),
  ],
  /** `policy`: the loan's Gap Cover for the upcoming closure, when bought (keeps max LTV through the Bell window). */
  withdraw: async (program: Program, owner: PublicKey, m: Market, amount: BN, policy: PublicKey | null = null) => [
    riskComputeBudget(),
    await program.methods
      .withdraw(amount)
      .accountsPartial({
        owner, senior: seniorPda(), market: m.key, position: positionPda(m.key, owner),
        ...riskAccounts(m.key, venueOf(m.symbol)), policy, guardianState: guardianPda(),
        ownerCollateral: ata(m.mint, owner), vault: vaultPda(m.key), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ],
  borrow: async (program: Program, owner: PublicKey, m: Market, amount: BN, policy: PublicKey | null = null) => [
    riskComputeBudget(),
    await program.methods
      .borrow(amount)
      .accountsPartial({
        owner, config: configPda(), senior: seniorPda(), market: m.key, position: positionPda(m.key, owner),
        ...riskAccounts(m.key, venueOf(m.symbol)), policy, guardianState: guardianPda(), usdcMint: USDC_MINT, ownerUsdc: ata(USDC_MINT, owner), usdcVault: usdcVaultPda(), ...tokenAccounts, ...ataAccounts,
      })
      .instruction(),
  ],
  repay: async (program: Program, owner: PublicKey, m: Market, amount: BN) => [
    ensureAta(owner, USDC_MINT),
    await program.methods
      .repay(amount)
      .accountsPartial({
        owner, config: configPda(), senior: seniorPda(), market: m.key, position: positionPda(m.key, owner),
        ownerUsdc: ata(USDC_MINT, owner), usdcVault: usdcVaultPda(), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ],
};

// ── Sending ──────────────────────────────────────────────────────────────────────────────────────

const PROGRAM_ERRORS = new Map(idl.errors.map((e) => [e.code, e.msg]));

/** A readable message for a failed transaction: the program's own error text when there is one. */
export function humanError(e: unknown): string {
  const text = e instanceof Error ? `${e.message} ${JSON.stringify((e as { logs?: string[] }).logs ?? "")}` : String(e);
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text)?.[1];
  const code = hex ? parseInt(hex, 16) : Number(/"Custom":(\d+)/.exec(text)?.[1] ?? /Error Number: (\d+)/.exec(text)?.[1] ?? NaN);
  if (PROGRAM_ERRORS.has(code)) return `${PROGRAM_ERRORS.get(code)}.`;
  if (/User rejected|rejected the request/i.test(text)) return "You rejected the request in your wallet.";
  if (/insufficient lamports|insufficient funds for (rent|fee)|Attempt to debit an account but found no record/i.test(text))
    return "The network fee couldn't be covered just now. Try again in a minute.";
  if (/insufficient funds/i.test(text)) return "Not enough tokens in your wallet for this.";
  if (/429|Too many requests/i.test(text)) return "The network is busy. Try again in a few seconds.";
  return e instanceof Error ? e.message : String(e);
}

export type ActivityNote = { icon: string; title: string; amount: string; kind: string };

/** Asks the server to cover this wallet's network fees when its balance is low (no-op otherwise). */
async function ensureFees(wallet: PublicKey) {
  await fetch("/api/gas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.toBase58() }) }).catch(() => null);
}

/** The wallet only signs; the app sends through its own connection, so the wallet's network setting doesn't matter,
 *  and the fees are covered by the server (ensureFees). */
export function useSend() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const qc = useQueryClient();
  return async (ixs: TransactionInstruction[], onStatus?: (s: string) => void, activity?: ActivityNote): Promise<string> => {
    if (!publicKey || !signTransaction) throw new Error("Connect a wallet first.");
    onStatus?.("Preparing…");
    await ensureFees(publicKey);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    onStatus?.("Confirm in wallet…");
    const signed = await signTransaction(tx);
    onStatus?.("Sending…");
    const sig = await connection.sendRawTransaction(signed.serialize());
    onStatus?.("Confirming…");
    const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) {
      const info = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      throw Object.assign(new Error(JSON.stringify(res.value.err)), { logs: info?.meta?.logMessages ?? [] });
    }
    if (activity) logActivity(publicKey.toBase58(), { ...activity, sig, when: Date.now() });
    await qc.invalidateQueries();
    return sig;
  };
}

export { SHARE_DECIMALS, USDC_DECIMALS };

/** The global risk parameters (RiskConfig), as fractions. */
export function useRiskConfig() {
  const program = useProgram();
  return useQuery({
    queryKey: ["risk-config"],
    staleTime: 300_000,
    queryFn: async () => {
      const c = await program.account.riskConfig.fetchNullable(riskConfigPda());
      if (!c) return null;
      const f = (x: BN) => Number(x.toString()) / 1e18;
      return {
        alpha: f(c.alpha), beta: f(c.beta), kappa: f(c.kappa), theta: f(c.theta), costOfCap: f(c.costOfCap),
        eta: f(c.eta), minPremium: fromUnits(c.minPremium), uMax: f(c.uMax), kStress: c.kStress,
      };
    },
  });
}

// ── Underwriter pool and Gap Cover ───────────────────────────────────────────────────────────────

import {
  EPOCH_PHASE,
  POOL_SHARE_DECIMALS,
  POOL_VIRTUAL_SHARES,
  coverComputeBudget,
  guardianPda,
  noAutoCoverPda,
  oraclePda,
  epochMarketPda,
  epochPda,
  jointPda,
  policyPda,
  poolEscrowPda,
  poolFreeCash,
  poolNav,
  poolPda,
  poolSharesPda,
  poolTicketPda,
  previewCover,
  projectedDebt,
  reservePda,
} from "@finity/solana";

export type Venue = "XNYS" | "USBANK";
export const POOL_LABEL: Record<Venue, string> = { XNYS: "Stock pool", USBANK: "T-Bill pool" };

export type EpochView = {
  seq: number;
  key: PublicKey;
  phase: string;
  closeAt: number;
  reopenAt: number;
  bellWindowAt: number;
  bellAt: number;
  closureType: number;
  premiums: number;
  policies: number;
  lossesPaid: number;
  equityAtRisk: number;
  navBefore: number;
  navAfter: number;
  settleSupply: bigint;
  /** worst_j (policy losses + uncovered bound) / J; J = NAV until the snapshot. */
  utilisation: number;
  worstLoss: number;
  raw: Awaited<ReturnType<Program["account"]["epoch"]["fetch"]>>;
};

export type PoolView = {
  venue: Venue;
  key: PublicKey;
  shareMint: PublicKey;
  nav: number;
  navRaw: bigint;
  cash: number;
  supply: bigint;
  sharePrice: number;
  unearned: number;
  depositsQueued: number;
  epochActive: boolean;
  epochsOpened: number;
  markets: PublicKey[];
  lossesPaid: number;
  /** Backstop inventory at its mark and T-Bill redemption claims at cost (both in NAV, not spendable cash). */
  inventoryMark: number;
  claimsCost: number;
  freeCash: number;
  epoch: EpochView | null;
  history: EpochView[];
};

function epochView(seq: number, key: PublicKey, e: EpochView["raw"], navNow: bigint): EpochView {
  let worst = 0n;
  for (let j = 0; j < e.policyLosses.length; j++) {
    const l = BigInt(e.policyLosses[j]!.toString()) + BigInt(e.uncovered[j]!.toString());
    if (l > worst) worst = l;
  }
  const j = e.phase >= 2 && !e.equityAtRisk.isZero() ? BigInt(e.equityAtRisk.toString()) : navNow;
  return {
    seq, key, phase: EPOCH_PHASE[e.phase] ?? "—",
    closeAt: Number(e.closeAt), reopenAt: Number(e.reopenAt), bellWindowAt: Number(e.bellWindowAt), bellAt: Number(e.bellAt),
    closureType: e.closureType, premiums: fromUnits(e.premiums), policies: e.policies, lossesPaid: fromUnits(e.lossesPaid),
    equityAtRisk: fromUnits(e.equityAtRisk), navBefore: fromUnits(e.navBefore), navAfter: fromUnits(e.navAfter),
    settleSupply: BigInt(e.settleSupply.toString()),
    utilisation: j === 0n ? 0 : Number(worst) / Number(j), worstLoss: Number(worst) / 1e6, raw: e,
  };
}

export function usePool(venue: Venue) {
  const program = useProgram();
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["pool", venue],
    refetchInterval: 15_000,
    queryFn: async (): Promise<PoolView | null> => {
      const key = poolPda(venue);
      const p = await program.account.underwriterPool.fetchNullable(key);
      if (!p) return null;
      const supply = BigInt((await connection.getTokenSupply(p.shareMint)).value.amount);
      const navRaw = poolNav(p);
      const opened = Number(p.epochsOpened.toString());
      const seqs = Array.from({ length: Math.min(opened, 6) }, (_, i) => opened - i);
      const epochs = await program.account.epoch.fetchMultiple(seqs.map((s) => epochPda(key, s)));
      const views = seqs.flatMap((s, i) => (epochs[i] ? [epochView(s, epochPda(key, s), epochs[i]!, navRaw)] : []));
      return {
        venue, key, shareMint: p.shareMint, navRaw, nav: Number(navRaw) / 1e6, cash: fromUnits(p.cash), supply,
        sharePrice: Number(((10n ** BigInt(POOL_SHARE_DECIMALS)) * (navRaw + 1n)) / (supply + POOL_VIRTUAL_SHARES)) / 1e6,
        unearned: fromUnits(p.unearnedPremiums), depositsQueued: fromUnits(p.depositsQueued), epochActive: p.epochActive,
        epochsOpened: opened, markets: p.markets, lossesPaid: fromUnits(p.lossesPaid),
        inventoryMark: fromUnits(p.inventoryMark), claimsCost: fromUnits(p.claimsCost), freeCash: Number(poolFreeCash(p)) / 1e6,
        epoch: p.epochActive ? (views.find((v) => v.seq === opened) ?? null) : null,
        history: views.filter((v) => v.phase === "Settled"),
      };
    },
  });
}

export function useReserve() {
  const program = useProgram();
  return useQuery({
    queryKey: ["reserve"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const r = await program.account.protocolReserve.fetchNullable(reservePda());
      return r ? { cash: fromUnits(r.cash), lossesPaid: fromUnits(r.lossesPaid) } : null;
    },
  });
}

export type PoolTicketView = { key: PublicKey; seq: number; depositAssets: number; withdrawShares: bigint; settled: boolean };

export function usePoolTickets(venue: Venue) {
  const program = useProgram();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["pool-tickets", venue, publicKey?.toBase58()],
    enabled: !!publicKey,
    refetchInterval: 15_000,
    queryFn: async (): Promise<PoolTicketView[]> => {
      const pool = poolPda(venue);
      // PoolTicket layout: discriminator (8), pool (32), owner (32).
      const rows = await program.account.poolTicket.all([
        { memcmp: { offset: 8, bytes: pool.toBase58() } },
        { memcmp: { offset: 40, bytes: publicKey!.toBase58() } },
      ]);
      const seqs = rows.map((r) => Number(r.account.epochSeq.toString()));
      const eps = await program.account.epoch.fetchMultiple(seqs.map((s) => epochPda(pool, s)));
      return rows
        .map((r, i) => ({
          key: r.publicKey, seq: seqs[i]!, depositAssets: fromUnits(r.account.depositAssets),
          withdrawShares: BigInt(r.account.withdrawShares.toString()), settled: eps[i]?.phase === 3,
        }))
        .sort((a, b) => a.seq - b.seq);
    },
  });
}

/** This wallet's Gap Cover for a market's upcoming closure, if bought. */
export function usePolicy(m: Market | undefined) {
  const program = useProgram();
  const { publicKey } = useWallet();
  const closureId = m?.clock ? m.clock.closureId + 1 : 0;
  return useQuery({
    queryKey: ["policy", m?.symbol, publicKey?.toBase58(), closureId],
    enabled: !!publicKey && !!m?.clock,
    refetchInterval: 15_000,
    queryFn: async () => {
      const key = policyPda(m!.key, publicKey!, closureId);
      const p = await program.account.policy.fetchNullable(key);
      return p ? { key, premium: fromUnits(p.premium), auto: p.auto } : null;
    },
  });
}

/** The Gap Cover quote for one loan (exactly what write_cover would charge now), or why it can't be bought. */
export function useCoverQuote(m: Market | undefined, p: Position | undefined) {
  const program = useProgram();
  const venue = m ? (venueOf(m.symbol) as Venue) : "XNYS";
  const pool = usePool(venue).data;
  return useQuery({
    queryKey: ["cover-quote", m?.symbol, p?.debt, pool?.epoch?.seq, pool?.navRaw?.toString()],
    enabled: !!m?.clock && !!p && p.debt > 0 && !!pool?.epoch,
    refetchInterval: 30_000,
    queryFn: async () => {
      const c = m!.clock!;
      const e = pool!.epoch!;
      const [cfg, set, joint, em] = await Promise.all([
        program.account.riskConfig.fetch(riskConfigPda()),
        program.account.riskSet.fetch(riskSetPda(m!.key, e.closureType)),
        program.account.jointColumn.fetch(jointPda(m!.key)),
        program.account.epochMarket.fetchNullable(epochMarketPda(e.key, m!.key)),
      ]);
      const days = c.nextReopenAt > c.nextCloseAt ? Math.ceil((c.nextReopenAt - c.nextCloseAt) / 86_400) : 4;
      const rate = BigInt(Math.round(m!.borrowApr * 1e18));
      const r = previewCover({
        set: { n: set.n, sigma: set.sigma, dividend: set.dividend, zTail: set.zTail }, cfg, joint: joint.z,
        policyLosses: e.raw.policyLosses, uncovered: e.raw.uncovered, bounds: em ? em.bounds : e.raw.uncovered.map(() => new BN(0)),
        coveredCollateral: em ? BigInt(em.coveredCollateral.toString()) : 0n,
        totalCollateral: BigInt(Math.round(m!.collateralTokens * 10 ** STOCK_DECIMALS)), price: BigInt(Math.round(m!.price * 1e6)),
        collateralDecimals: STOCK_DECIMALS, maxLtvBps: Math.round(m!.maxLtv * 10_000),
        positionCollateral: BigInt(p!.tokensRaw.toString()), debtProjected: projectedDebt(p!.debtRaw, rate, days), closureDays: days,
        equity: e.equityAtRisk > 0 ? BigInt(Math.round(e.equityAtRisk * 1e6)) : pool!.navRaw,
      });
      return "error" in r ? { error: r.error } : { premium: Number(r.premium) / 1e6, utilAfter: r.utilAfter, safeLtv: m!.safeLtvByType[e.closureType] ?? 0 };
    },
  });
}

export const poolIx = {
  deposit: async (program: Program, owner: PublicKey, venue: Venue, assets: BN) => [
    ensureAta(owner, USDC_MINT),
    await program.methods
      .poolDeposit(assets)
      .accountsPartial({
        owner, config: configPda(), pool: poolPda(venue), usdcMint: USDC_MINT, shareMint: poolSharesPda(venue),
        ownerUsdc: ata(USDC_MINT, owner), ownerShares: ata(poolSharesPda(venue), owner), usdcVault: usdcVaultPda(), ...tokenAccounts, ...ataAccounts,
      })
      .instruction(),
  ],
  depositQueued: async (program: Program, owner: PublicKey, venue: Venue, seq: number, assets: BN) => [
    await program.methods
      .poolDepositQueued(assets)
      .accountsPartial({
        owner, config: configPda(), pool: poolPda(venue), epoch: epochPda(poolPda(venue), seq),
        ticket: poolTicketPda(poolPda(venue), owner, seq), ownerUsdc: ata(USDC_MINT, owner), usdcVault: usdcVaultPda(), ...tokenAccounts,
      })
      .instruction(),
  ],
  requestWithdraw: async (program: Program, owner: PublicKey, venue: Venue, nextSeq: number, shares: BN) => [
    await program.methods
      .poolRequestWithdraw(shares)
      .accountsPartial({
        owner, pool: poolPda(venue), shareMint: poolSharesPda(venue), ownerShares: ata(poolSharesPda(venue), owner),
        escrow: poolEscrowPda(venue), ticket: poolTicketPda(poolPda(venue), owner, nextSeq), ...tokenAccounts,
      })
      .instruction(),
  ],
  claim: async (program: Program, owner: PublicKey, venue: Venue, seq: number) => [
    await program.methods
      .poolClaim(new BN(seq))
      .accountsPartial({
        owner, config: configPda(), pool: poolPda(venue), epoch: epochPda(poolPda(venue), seq), ticket: poolTicketPda(poolPda(venue), owner, seq),
        usdcMint: USDC_MINT, shareMint: poolSharesPda(venue), escrow: poolEscrowPda(venue), ownerShares: ata(poolSharesPda(venue), owner),
        ownerUsdc: ata(USDC_MINT, owner), usdcVault: usdcVaultPda(), ...tokenAccounts, ...ataAccounts,
      })
      .instruction(),
  ],
  /** The borrower's own Gap Cover purchase for the upcoming closure. */
  buyCover: async (program: Program, owner: PublicKey, m: Market, pool: PoolView, maxPremium: BN, addToDebt: boolean) => {
    const e = pool.epoch!;
    const c = m.clock!;
    return [
      coverComputeBudget(),
      await program.methods
        .writeCover(maxPremium, addToDebt, false)
        .accountsPartial({
          payer: owner, config: configPda(), senior: seniorPda(), market: m.key, position: positionPda(m.key, owner),
          ...riskAccounts(m.key, venueOf(m.symbol)), riskSet: riskSetPda(m.key, e.closureType), joint: jointPda(m.key),
          pool: pool.key, epoch: e.key, epochMarket: epochMarketPda(e.key, m.key), policy: policyPda(m.key, owner, c.closureId + 1), guardianState: guardianPda(),
          optOut: noAutoCoverPda(positionPda(m.key, owner)),
          ownerUsdc: addToDebt ? null : ata(USDC_MINT, owner), usdcVault: usdcVaultPda(), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  },
};

/** The price signer set and the guardian's switches. */
export function useOracleGuardian() {
  const program = useProgram();
  return useQuery({
    queryKey: ["oracle-guardian"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const [o, g] = await Promise.all([program.account.oracleConfig.fetchNullable(oraclePda()), program.account.guardianState.fetchNullable(guardianPda())]);
      const now = Date.now() / 1000;
      return {
        signers: o?.signers.length ?? 0,
        threshold: o?.threshold ?? 0,
        keeperPrices: o ? o.keeperPriceAllowed : true,
        borrowPaused: !!g?.borrowPaused,
        coverPaused: !!g?.coverPaused,
        haircut: g && Number(g.haircutUntil) > now ? g.haircutBps / 10_000 : 0,
      };
    },
  });
}

/** Auto-cover state per loan: on unless the borrower's opt-out marker exists. */
export function useAutoCover(loans: Position[]) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["auto-cover", loans.map((l) => l.key.toBase58()).join()],
    enabled: loans.length > 0,
    queryFn: async () => {
      const infos = await connection.getMultipleAccountsInfo(loans.map((l) => noAutoCoverPda(l.key)));
      return Object.fromEntries(loans.map((l, i) => [l.key.toBase58(), !infos[i]])) as Record<string, boolean>;
    },
  });
}

export const autoCoverIx = async (program: Program, owner: PublicKey, m: Market, enabled: boolean) => [
  await program.methods
    .setAutoCover(enabled)
    .accountsPartial({ owner, market: m.key, position: positionPda(m.key, owner), optOut: noAutoCoverPda(positionPda(m.key, owner)), systemProgram: SystemProgram.programId })
    .instruction(),
];
