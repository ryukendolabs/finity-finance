// Shared Finity Solana client: program IDL/types, PDA derivation, the market list, the devnet address book,
// and exact BigInt ports of the program's interest and share math. Used by the scripts, the keeper and the web app.
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";

import devnet from "./devnet.json" with { type: "json" };
import idl from "./idl.json" with { type: "json" };
import type { Finity } from "./types";

export type { Finity };
export { BN, idl };

export const PROGRAM_ID = new PublicKey(idl.address);
export const USDC_DECIMALS = 6;
export const STOCK_DECIMALS = 6;
export const SHARE_DECIMALS = 9;
export const MAX_PRICE_AGE_SECS = 600;
export const FAUCET_MAX_WHOLE = 1_000;

export type SessionName = "open" | "closed" | "halted";
/** Anchor encodes the `Session` enum as `{ open: {} }` etc. */
export const session = (s: SessionName) => ({ [s]: {} }) as never;
export const sessionName = (s: object): SessionName => Object.keys(s)[0] as SessionName;

// ───────────── markets ─────────────

const WAD_N = 1e18;
const usd = (n: number) => n * 1e6;

export interface MarketSpec {
  symbol: string;
  name: string;
  /** Yahoo Finance ticker the keeper prices it from. */
  quote: string;
  /** Follows US equity market hours (XNYS); false = the bank calendar of a NAV fund (USBANK). */
  marketHours: boolean;
  /** Calendar venue: XNYS for stocks, USBANK for the T-Bill fund. */
  venue: "XNYS" | "USBANK";
  maxLtvBps: number;
  closedLtvBps: number;
  liqThresholdBps: number;
  liqBonusBps: number;
  /** Kinked rate model, fractions per year (r0, s1, s2, kink). */
  rate: [number, number, number, number];
  supplyCap: number;
  borrowCap: number;
  vaultCap: number;
}

/** Protocol parameters: equity 75% / 80%, λ 3%, IRM 2% / 6% / 80% / 90%, caps $2M / $1.4M;
 *  NAV 90% / 93%, λ 1%, IRM 1% / 4% / 60% / 92%, caps $5M / $4.5M. Vault caps split the seeded $5M
 *  (6 × $600k + $1.4M) the way the allocator did. Closure-safe LTVs are static until the
 *  risk engine port computes them per closure. */
const equity = (symbol: string, name: string, quote = symbol): MarketSpec => ({
  symbol, name, quote, marketHours: true, venue: "XNYS",
  maxLtvBps: 7500, closedLtvBps: 5500, liqThresholdBps: 8000, liqBonusBps: 300,
  rate: [0.02, 0.06, 0.8, 0.9], supplyCap: usd(2_000_000), borrowCap: usd(1_400_000), vaultCap: usd(600_000),
});

export const MARKETS: MarketSpec[] = [
  equity("AAPL", "Apple"),
  equity("AMZN", "Amazon"),
  equity("GOOGL", "Alphabet"),
  equity("MSFT", "Microsoft"),
  equity("NVDA", "NVIDIA"),
  equity("TSLA", "Tesla"),
  {
    symbol: "TBILL", name: "T-Bill Fund", quote: "SGOV", marketHours: false, venue: "USBANK",
    maxLtvBps: 9000, closedLtvBps: 9000, liqThresholdBps: 9300, liqBonusBps: 100,
    rate: [0.01, 0.04, 0.6, 0.92], supplyCap: usd(5_000_000), borrowCap: usd(4_500_000), vaultCap: usd(1_400_000),
  },
];

export const toWad = (x: number) => new BN(BigInt(Math.round(x * 1e6)) * 10n ** 12n + "");

/** Address book written by `pnpm seed`. Empty until the program is deployed and seeded. */
export interface Deployment {
  cluster: string;
  programId: string;
  layout: string;
  usdcMint: string;
  mints: Record<string, string>;
}
export const DEVNET = devnet as Deployment;
/** Seed layout version (`constants.rs`): a deployment of an older layout is not reused. */
export const LAYOUT = "v2";

// ───────────── PDAs ─────────────

const seed = (s: string) => new TextEncoder().encode(`${LAYOUT}/${s}`);
const find = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const u64le = (n: number | bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};

export const configPda = () => find([seed("config")]);
export const usdcVaultPda = () => find([seed("usdc_vault")]);
export const seniorPda = () => find([seed("senior")]);
export const shareMintPda = () => find([seed("senior_shares")]);
export const shareEscrowPda = () => find([seed("senior_escrow")]);
export const deadSharesPda = () => find([seed("senior_dead")]);
export const redeemPda = (id: number | bigint) => find([seed("redeem"), u64le(id)]);
export const marketPda = (mint: PublicKey) => find([seed("market"), mint.toBytes()]);
export const vaultPda = (market: PublicKey) => find([seed("vault"), market.toBytes()]);
export const positionPda = (market: PublicKey, owner: PublicKey) => find([seed("position"), market.toBytes(), owner.toBytes()]);
/** Venue names are 8 bytes, zero-padded. */
export const venueBytes = (venue: string) => {
  const b = new Uint8Array(8);
  b.set(new TextEncoder().encode(venue).slice(0, 8));
  return b;
};
export const calendarPda = (venue: string) => find([seed("calendar"), venueBytes(venue)]);
export const clockPda = (market: PublicKey) => find([seed("clock"), market.toBytes()]);
export const riskConfigPda = () => find([seed("risk_config")]);
export const riskSetPda = (market: PublicKey, closureType: number) => find([seed("risk"), market.toBytes(), Uint8Array.of(closureType)]);

export const CLOSURE = { NONE: 0, OVERNIGHT: 1, WEEKEND: 2, HOLIDAY_WEEKEND: 3, HALT: 4, CORP_ACTION: 5 } as const;
export const CLOSURE_NAMES: Record<number, string> = {
  0: "None", 1: "Overnight", 2: "Weekend", 3: "Holiday weekend", 4: "Halt", 5: "Corporate action",
};
/** The risk accounts every borrow-limit check takes. */
export const riskAccounts = (market: PublicKey, venue: string) => ({
  clock: clockPda(market),
  calendar: calendarPda(venue),
  riskConfig: riskConfigPda(),
  riskOvernight: riskSetPda(market, CLOSURE.OVERNIGHT),
  riskWeekend: riskSetPda(market, CLOSURE.WEEKEND),
  riskHoliday: riskSetPda(market, CLOSURE.HOLIDAY_WEEKEND),
});
/** Borrow, withdraw and liquidate poke the clock and price the closure risk: ~175k CU measured, so they ask
 *  for headroom over Solana's 200k default. */
export const RISK_CU_LIMIT = 300_000;
export const riskComputeBudget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: RISK_CU_LIMIT });
export const venueOf = (symbol: string) => MARKETS.find((m) => m.symbol === symbol)?.venue ?? "XNYS";

export const finityProgram = (provider: AnchorProvider) => new Program<Finity>(idl as Finity, provider);

/** Base units ↔ decimal numbers. */
export const toUnits = (x: number, decimals = 6) => new BN(Math.round(x * 10 ** decimals).toString());
export const fromUnits = (x: BN | bigint | number, decimals = 6) => Number(x.toString()) / 10 ** decimals;

// ───────────── exact math (programs/finity/src/math.rs) ─────────────

const WAD = 10n ** 18n;
const YEAR = 365n * 24n * 3600n;
const VS = 1_000_000n; // borrow-share virtual offsets
const VA = 1n;
const big = (x: BN | number | bigint) => BigInt(x.toString());
const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b;

export interface MarketLike {
  totalSupplyAssets: BN;
  totalBorrowAssets: BN;
  totalBorrowShares: BN;
  poolFeeAccrued: BN;
  treasuryFeeAccrued: BN;
  lastAccrual: BN;
  feePoolBps: number;
  feeTreasuryBps: number;
  rate: { r0: BN; s1: BN; s2: BN; uKink: BN };
}

export interface Lending {
  supply: bigint;
  borrow: bigint;
  borrowShares: bigint;
  poolFees: bigint;
  treasuryFees: bigint;
}

export function borrowRateWad(supply: bigint, borrow: bigint, r: MarketLike["rate"]): bigint {
  const u = supply === 0n ? 0n : (borrow * WAD) / supply;
  const [r0, s1, s2, k] = [big(r.r0), big(r.s1), big(r.s2), big(r.uKink)];
  return u <= k ? r0 + (s1 * u) / k : r0 + s1 + (s2 * (u - k)) / (WAD - k);
}

/** The market's lending figures accrued to `now` (Market::accrue, read-only). */
export function accrued(m: MarketLike, now = Math.floor(Date.now() / 1000)): Lending {
  const s: Lending = {
    supply: big(m.totalSupplyAssets),
    borrow: big(m.totalBorrowAssets),
    borrowShares: big(m.totalBorrowShares),
    poolFees: big(m.poolFeeAccrued),
    treasuryFees: big(m.treasuryFeeAccrued),
  };
  const dt = BigInt(Math.max(0, now - Number(m.lastAccrual.toString())));
  if (dt === 0n || s.borrow === 0n) return s;
  const r = borrowRateWad(s.supply, s.borrow, m.rate);
  const i = divUp(divUp(s.borrow * r, WAD) * dt, YEAR);
  const fees = (i * BigInt(m.feePoolBps + m.feeTreasuryBps)) / 10_000n;
  const fp = (i * BigInt(m.feePoolBps)) / 10_000n;
  return { ...s, borrow: s.borrow + i, poolFees: s.poolFees + fp, treasuryFees: s.treasuryFees + fees - fp, supply: s.supply + i - fees };
}

/** Debt of `shares` borrow shares, rounded up (Market::debt_of). */
export const debtOf = (shares: BN | bigint, l: Lending) =>
  shares.toString() === "0" ? 0n : divUp(big(shares) * (l.borrow + VA), l.borrowShares + VS);

/** Market cash available to borrow: S + fees − B. */
export const liquidityOf = (l: Lending) => {
  const cash = l.supply + l.poolFees + l.treasuryFees;
  return cash > l.borrow ? cash - l.borrow : 0n;
};

/** Borrow APR and the senior supply APY (borrow rate × utilization × senior share), as fractions. */
export function rates(m: MarketLike, l: Lending) {
  const r = Number(borrowRateWad(l.supply, l.borrow, m.rate)) / WAD_N;
  const util = l.supply === 0n ? 0 : Number(l.borrow) / Number(l.supply);
  const senior = 1 - (m.feePoolBps + m.feeTreasuryBps) / 10_000;
  return { borrowApr: r, utilization: util, supplyApr: r * util * senior };
}

/** Senior vault share price inputs: total assets = idle + Σ accrued market supply. */
export const VAULT_VIRTUAL_SHARES = 1_000n;
export const sharesToAssets = (shares: bigint, totalAssets: bigint, supply: bigint) =>
  (shares * (totalAssets + 1n)) / (supply + VAULT_VIRTUAL_SHARES);
export const assetsToShares = (assets: bigint, totalAssets: bigint, supply: bigint) =>
  (assets * (supply + VAULT_VIRTUAL_SHARES)) / (totalAssets + 1n);

/** Health of a position in USDC: value, debt, the current borrow limit and the liquidation limit. */
export function positionHealth(
  m: MarketLike & { price: BN; collateralDecimals: number; session: object; maxLtvBps: number; closedLtvBps: number; liqThresholdBps: number },
  p: { collateral: BN; borrowShares: BN },
  now?: number,
) {
  const value = fromUnits(p.collateral, m.collateralDecimals) * fromUnits(m.price) || 0;
  const ltv = sessionName(m.session) === "open" ? m.maxLtvBps : m.closedLtvBps;
  const debtRaw = debtOf(p.borrowShares, accrued(m, now));
  const debt = Number(debtRaw) / 1e6;
  return {
    value,
    debt,
    debtRaw,
    borrowLimit: (value * ltv) / 10_000,
    liqLimit: (value * m.liqThresholdBps) / 10_000,
    liquidatable: debt > 0 && debt > (value * m.liqThresholdBps) / 10_000,
  };
}

// ───────────── account scans ─────────────

/** Position account size: discriminator + owner + market + collateral (u64) + borrow_shares (u128) + bump.
 *  Filtering on it skips accounts of older layouts, which share the type tag. */
export const POSITION_SIZE = 8 + 32 + 32 + 8 + 16 + 1;

/** The current layout's markets, in senior-vault order (the vault lists exactly the v2 markets). */
export async function fetchMarkets(program: Program<Finity>) {
  const v = await program.account.seniorVault.fetch(seniorPda());
  const accounts = await program.account.market.fetchMultiple(v.markets);
  return v.markets.flatMap((publicKey, i) => (accounts[i] ? [{ publicKey, account: accounts[i]! }] : []));
}

export const fetchPositions = (program: Program<Finity>, owner?: PublicKey) =>
  program.account.position.all([
    { dataSize: POSITION_SIZE },
    ...(owner ? [{ memcmp: { offset: 8, bytes: owner.toBase58() } }] : []),
  ]);

// ───────────── clock and risk (programs/finity/src/clock.rs, risk.rs) ─────────────

export type ClockStateName = "regular" | "extended" | "closed" | "reopen" | "halted" | "corpAction";
export const clockStateName = (s: object) => Object.keys(s)[0] as ClockStateName;

const BIG_THOUSAND = 1000n;
const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint) => divUp(a * b, d);

/** g = max(0, 1 + σ·z/1000 − d) × (1 − κ), rounded down (risk-core gap_factor). */
export function gapFactor(z: number, sigma: bigint, dividend: bigint, kappa: bigint): bigint {
  const az = BigInt(Math.abs(z));
  const base = z >= 0 ? WAD + mulDiv(sigma, az, BIG_THOUSAND) : WAD - mulDivUp(sigma, az, BIG_THOUSAND);
  const b = base < 0n ? 0n : base; // saturating, as in Rust
  const net = b > dividend ? b - dividend : 0n;
  return mulDiv(net, WAD - kappa, WAD);
}

export const quantileIndex = (n: number, alpha: bigint) => Math.max(0, Number(mulDivUp(alpha, BigInt(n), WAD)) - 1);

export interface RiskSetLike { n: number; sigma: BN; dividend: BN; zTail: number[] }
export interface RiskConfigLike { alpha: BN; beta: BN; kappa: BN; theta: BN; costOfCap: BN; eta: BN; minPremium: BN; uMax: BN }

/** Safe LTV (WAD) of a set, capped at max LTV. */
export function safeLtvWad(set: RiskSetLike, cfg: RiskConfigLike, maxLtvBps: number): bigint {
  const z = set.zTail[quantileIndex(set.n, big(cfg.alpha))] ?? -32768;
  const g = gapFactor(z, big(set.sigma), big(set.dividend), big(cfg.kappa));
  const max = (BigInt(maxLtvBps) * WAD) / 10_000n;
  return g < max ? g : max;
}

/** D_proj = D × (1 + r × days / 365), rounded up. */
export const projectedDebt = (debt: bigint, rateWad: bigint, days: number) => mulDivUp(debt, WAD + mulDivUp(rateWad, BigInt(days), 365n), WAD);

export const closureDays = (closeAt: number, reopenAt: number) =>
  closeAt > 0 && reopenAt > closeAt ? Math.ceil((reopenAt - closeAt) / 86_400) : null;

export interface ClockLike {
  state: object;
  reopenPending: boolean;
  closureType: number;
  closeAt: BN;
  reopenAt: BN;
  nextClosureType: number;
  nextCloseAt: BN;
  nextReopenAt: BN;
  bellWindowAt: BN;
}

/** The closure the safe rule looks at: in progress, else the next scheduled one; halts use the holiday set. */
export function safeRuleClosure(c: ClockLike): { type: number; days: number | null } {
  const [t, days] = c.reopenPending
    ? [c.closureType, closureDays(Number(c.closeAt), Number(c.reopenAt))]
    : [c.nextClosureType, closureDays(Number(c.nextCloseAt), Number(c.nextReopenAt))];
  return { type: t >= 1 && t <= 3 ? t : CLOSURE.HOLIDAY_WEEKEND, days };
}

/** The limit that applies now (clock.rs check_limit): which rule, the LTV, and the debt it is measured on. */
export function borrowRule(c: ClockLike, now = Math.floor(Date.now() / 1000)) {
  const state = clockStateName(c.state);
  const paused = state === "reopen" || state === "corpAction";
  const bell = Number(c.bellWindowAt);
  const open = state === "regular" && (bell === 0 || now < bell);
  return { paused, open, closure: safeRuleClosure(c) };
}

export interface PremiumInputs {
  set: RiskSetLike;
  cfg: RiskConfigLike;
  collateralValue: bigint;
  debtProjected: bigint;
  closureDays: number;
  utilAfter: bigint;
}

/** Gap Cover premium (risk-core quote_cover), loan base units; null when the stored tail can't price it. */
export function quoteCover(p: PremiumInputs): { premium: bigint; expectedLoss: bigint; expectedShortfall: bigint } | null {
  const { set, cfg } = p;
  const n = set.n;
  const beta = big(cfg.beta);
  let m = Number(mulDivUp(WAD - beta, BigInt(n), WAD));
  m = Math.min(Math.max(m, 1), n);
  if (m > set.zTail.length) return null;
  let total = 0n, worst = 0n, i = 0, ended = false;
  for (; i < set.zTail.length && i < n; i++) {
    const g = gapFactor(set.zTail[i]!, big(set.sigma), big(set.dividend), big(cfg.kappa));
    const covered = mulDiv(p.collateralValue, g, WAD);
    const l = p.debtProjected > covered ? p.debtProjected - covered : 0n;
    if (l === 0n) { ended = true; break; }
    total += l;
    if (i < m) worst += l;
  }
  if (!ended && i !== n) return null;
  const el = divUp(total, BigInt(n));
  const es = divUp(worst, BigInt(m));
  const tau = mulDivUp(BigInt(p.closureDays), WAD, 365n);
  const loaded = mulDivUp(WAD + big(cfg.theta), el, WAD);
  const capital = mulDivUp(mulDivUp(big(cfg.costOfCap), tau, WAD), es, WAD);
  const mult = WAD + mulDivUp(big(cfg.eta), mulDivUp(p.utilAfter, p.utilAfter, WAD), WAD);
  const premium = mulDivUp(mult, loaded + capital, WAD);
  const floor = big(cfg.minPremium);
  return { premium: premium > floor ? premium : floor, expectedLoss: el, expectedShortfall: es };
}

// ───────────── underwriter pool, Gap Cover, reserve (pool_ix.rs, cover_ix.rs) ─────────────

export const POOL_SHARE_DECIMALS = 9;
export const K_STRESS = 256;
export const EPOCH_PHASE: Record<number, string> = { 0: "None", 1: "Open", 2: "Snapshot", 3: "Settled" };

export const poolPda = (venue: string) => find([seed("pool"), venueBytes(venue)]);
export const poolSharesPda = (venue: string) => find([seed("pool_shares"), venueBytes(venue)]);
export const poolEscrowPda = (venue: string) => find([seed("pool_escrow"), venueBytes(venue)]);
export const epochPda = (pool: PublicKey, seq: number | bigint) => find([seed("epoch"), pool.toBytes(), u64le(seq)]);
export const epochMarketPda = (epoch: PublicKey, market: PublicKey) => find([seed("epoch_mkt"), epoch.toBytes(), market.toBytes()]);
export const policyPda = (market: PublicKey, owner: PublicKey, closureId: number | bigint) =>
  find([seed("policy"), market.toBytes(), owner.toBytes(), u64le(closureId)]);
export const poolTicketPda = (pool: PublicKey, owner: PublicKey, seq: number | bigint) =>
  find([seed("pool_ticket"), pool.toBytes(), owner.toBytes(), u64le(seq)]);
export const reservePda = () => find([seed("reserve")]);
export const jointPda = (market: PublicKey) => find([seed("joint"), market.toBytes()]);
export const poolOf = (symbol: string) => poolPda(venueOf(symbol));

/** A cover write evaluates ~770 gap factors (~680k CU measured); a capacity refresh ~256 (~410k). */
export const COVER_CU_LIMIT = 1_000_000;
export const REFRESH_CU_LIMIT = 600_000;
export const coverComputeBudget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: COVER_CU_LIMIT });

/** R-03: coverable up to max LTV + 0.5 pp, never above the liquidation threshold − 2 pp (fraction). */
export const coverableLtv = (maxLtvBps: number, liqThresholdBps: number) => Math.min(maxLtvBps + 50, liqThresholdBps - 200) / 10_000;

export interface CoverPreviewInput {
  set: RiskSetLike;
  cfg: RiskConfigLike;
  joint: number[];
  /** Epoch aggregates and this market's epoch account. */
  policyLosses: BN[] | bigint[];
  uncovered: BN[] | bigint[];
  bounds: BN[] | bigint[];
  coveredCollateral: bigint;
  /** Market: total collateral (base units), price (USDC base per whole token), decimals, max LTV. */
  totalCollateral: bigint;
  price: bigint;
  collateralDecimals: number;
  maxLtvBps: number;
  /** The loan: collateral (base units), debt projected to the reopen (USDC base). */
  positionCollateral: bigint;
  debtProjected: bigint;
  closureDays: number;
  /** J: the snapshot, or pool NAV before it. */
  equity: bigint;
}

/** What `write_cover` would charge now: premium (USDC base units) and pool utilisation after, or why not. */
export function previewCover(p: CoverPreviewInput): { premium: bigint; utilAfter: number } | { error: string } {
  const scale = 10n ** BigInt(p.collateralDecimals);
  const value = (q: bigint) => (q * p.price) / scale;
  const c = value(p.positionCollateral);
  const cUnc = value(p.totalCollateral - (p.coveredCollateral + p.positionCollateral > p.totalCollateral ? p.totalCollateral : p.coveredCollateral + p.positionCollateral));
  const safe = safeLtvWad(p.set, p.cfg, p.maxLtvBps);
  let worst = 0n;
  for (let j = 0; j < K_STRESS; j++) {
    const g = gapFactor(p.joint[j]!, big(p.set.sigma), big(p.set.dividend), big(p.cfg.kappa));
    const b = g >= safe ? 0n : mulDivUp(cUnc, safe - g, WAD);
    const covered = mulDiv(c, g, WAD);
    const add = p.debtProjected > covered ? p.debtProjected - covered : 0n;
    const uncovered = big(p.uncovered[j]!) - big(p.bounds[j]!) + b;
    const lambda = big(p.policyLosses[j]!) + add + (uncovered > 0n ? uncovered : 0n);
    if (lambda > worst) worst = lambda;
  }
  const util = worst === 0n ? 0n : p.equity === 0n ? 2n ** 127n : mulDivUp(worst, WAD, p.equity);
  if (util > big(p.cfg.uMax)) return { error: "The pool has no capacity left for this cover." };
  const q = quoteCover({ set: p.set, cfg: p.cfg, collateralValue: c, debtProjected: p.debtProjected, closureDays: p.closureDays, utilAfter: util });
  if (!q) return { error: "This loan is too risky to price from the stored scenarios." };
  return { premium: q.premium, utilAfter: Number(util) / 1e18 };
}

/** Pool NAV = cash − unearned premiums − queued deposits − reserved withdrawals (UnderwriterPool::nav). */
/** Cash the pool can spend (UnderwriterPool::free_cash). */
export const poolFreeCash = (p: { cash: BN; unearnedPremiums: BN; depositsQueued: BN; withdrawReserved: BN }) => {
  const n = big(p.cash) - big(p.unearnedPremiums) - big(p.depositsQueued) - big(p.withdrawReserved);
  return n > 0n ? n : 0n;
};
/** NAV (UnderwriterPool::nav, §8.6.1): free cash + backstop inventory at its mark + T-Bill redemption claims at cost. */
export const poolNav = (p: {
  cash: BN; unearnedPremiums: BN; depositsQueued: BN; withdrawReserved: BN; inventoryMark?: BN; claimsCost?: BN;
}) => poolFreeCash(p) + (p.inventoryMark ? big(p.inventoryMark) : 0n) + (p.claimsCost ? big(p.claimsCost) : 0n);
export const POOL_VIRTUAL_SHARES = 1_000n;

// ───────────── auctions (auction_ix.rs) ─────────────

import { sha256 } from "@noble/hashes/sha256";

export const AUCTION_KIND = { REOPEN: 0, INTRADAY: 1, EMERGENCY: 2, PRECLOSE: 3 } as const;
export const AUCTION_KIND_NAME: Record<number, string> = { 0: "Reopen", 1: "Intraday", 2: "Emergency", 3: "Pre-close" };
export const AUCTION_PHASE: Record<number, string> = { 1: "Queue", 2: "Bidding", 3: "Reveal", 4: "Cleared", 5: "Cancelled" };
/** [lotFixAt, biddingStart, commitEnd/biddingEnd, clearAt] offsets: REOPEN / INTRADAY from creation, PRECLOSE before the close. */
export const TIMINGS = { REOPEN: [120, 120, 300, 420], INTRADAY: [15, 15, 60, 60], PRECLOSE: [300, 300, 30, 30] } as const;

export const auctionBookPda = (market: PublicKey) => find([seed("auction_book"), market.toBytes()]);
export const auctionPda = (market: PublicKey, id: number | bigint) => find([seed("auction"), market.toBytes(), u64le(id)]);
export const lotEntryPda = (auction: PublicKey, owner: PublicKey) => find([seed("lot_entry"), auction.toBytes(), owner.toBytes()]);
export const bidPda = (auction: PublicKey, bidder: PublicKey) => find([seed("bid"), auction.toBytes(), bidder.toBytes()]);
export const lockPda = (position: PublicKey) => find([seed("plock"), position.toBytes()]);

/** Sealed-bid commitment: sha256("finity-bid" ‖ auction ‖ bidder ‖ qty LE ‖ price LE ‖ salt) (auction_ix.rs). */
export function bidCommitment(auction: PublicKey, bidder: PublicKey, qty: bigint, price: bigint, salt: Uint8Array): number[] {
  const parts = [new TextEncoder().encode("finity-bid"), auction.toBytes(), bidder.toBytes(), u64le(qty), u64le(price), salt];
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return Array.from(sha256(buf));
}

/** The joinable auction of a kind, or the next id to create (AuctionBook). */
export function auctionIdFor(
  book: { nextId: BN; intraday: BN; reopen: BN; reopenClosure: BN; preclose: BN; precloseClosure: BN } | null,
  kind: number,
  closureId: number,
  joinable: (id: number) => boolean,
): number {
  if (!book) return 1;
  const next = Number(book.nextId.toString()) + 1;
  const cand =
    kind === AUCTION_KIND.INTRADAY || kind === AUCTION_KIND.EMERGENCY ? Number(book.intraday) :
    kind === AUCTION_KIND.REOPEN ? (Number(book.reopenClosure) === closureId ? Number(book.reopen) : 0) :
    Number(book.precloseClosure) === closureId ? Number(book.preclose) : 0;
  return cand && joinable(cand) ? cand : next;
}

// ───────────── signed prices and the guardian (oracle_ix.rs) ─────────────

import { Ed25519Program, type Keypair as Web3Keypair } from "@solana/web3.js";

export const oraclePda = () => find([seed("oracle")]);
export const guardianPda = () => find([seed("guardian")]);
export const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

/** "FNTY" ‖ market ‖ price (u64 LE) ‖ observed_at (i64 LE): what each relayer node signs. */
export function priceReport(market: PublicKey, price: bigint, observedAt: number): Uint8Array {
  const b = new Uint8Array(52);
  b.set(new TextEncoder().encode("FNTY"), 0);
  b.set(market.toBytes(), 4);
  new DataView(b.buffer).setBigUint64(36, price, true);
  new DataView(b.buffer).setBigInt64(44, BigInt(observedAt), true);
  return b;
}

/** One Ed25519 precompile instruction per node signature (offsets inside the instruction, as the program requires). */
export const signedReportIx = (node: Web3Keypair, market: PublicKey, price: bigint, observedAt: number) =>
  Ed25519Program.createInstructionWithPrivateKey({ privateKey: node.secretKey, message: priceReport(market, price, observedAt) });

/** The loan's auto-cover opt-out marker (exists = auto-cover off). */
export const noAutoCoverPda = (position: PublicKey) => find([seed("no_autocover"), position.toBytes()]);

// ───────────── backstop inventory: GDA resale and T-Bill redemptions (inventory_ix.rs) ─────────────

export const inventoryPda = (pool: PublicKey, mint: PublicKey) => find([seed("inventory"), pool.toBytes(), mint.toBytes()]);
export const redemptionPda = (pool: PublicKey, id: number | bigint) => find([seed("redemption"), pool.toBytes(), u64le(id)]);
/** λ: the GDA price halves every 24 h (WAD per second). */
export const GDA_DECAY_WAD = 8_022_536_812_036n;
/** A GDA can be ended by anyone after twice its 3-day emission period. */
export const GDA_MAX_RUN_SECS = 6 * 86_400;
/** κ_nav: a T-Bill lot's reserve sits 0.5% under the fund's NAV. */
export const KAPPA_NAV = 0.005;

/**
 * USDC cost (base units) of the next `qty` units of a running GDA at `now` (unix seconds), as the program charges
 * it: the continuous price k·(r/λ)·e^(−λ(t − s/r))·(e^(λq/r) − 1)/10^dec, floored at qty × (1 − κ) × V. A float
 * preview: the program's fixed-point result can differ in the last unit, so pass a small slippage as max_cost.
 */
export function gdaQuote(
  g: { k: BN; decay: BN; emissionPerSec: BN; sold: BN; start: BN },
  qty: bigint,
  now: number,
  price: BN,
  decimals: number,
  kappa: number,
): bigint {
  if (qty === 0n) return 0n;
  const lam = Number(g.decay.toString()) / 1e18;
  const r = Number(g.emissionPerSec.toString());
  const t = now - Number(g.start.toString());
  const k = Number(g.k.toString());
  const cont = (k * (r / lam) * Math.exp(-lam * (t - Number(g.sold.toString()) / r)) * (Math.exp((lam * Number(qty)) / r) - 1)) / 10 ** decimals;
  const floor = ((Number(qty) * Number(price.toString())) / 10 ** decimals) * (1 - kappa);
  return BigInt(Math.ceil(Math.max(cont, floor)));
}
