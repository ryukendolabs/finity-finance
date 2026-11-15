"use client";

import { BN, STOCK_DECIMALS, USDC_DECIMALS } from "@finity/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { TransactionInstruction } from "@solana/web3.js";
import { useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { explorerTx, ticker } from "@/lib/protocol";
import { et } from "@/lib/time";
import { LOAN_SYMBOL, humanError, ix, poolIx, useProgram, useSend, type ActivityNote, type Market, type PoolView, type Position } from "@/lib/solana";
import type { PublicKey } from "@solana/web3.js";

const usd = (n: number, d = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d });
const num = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
/** A number for an input box: no grouping, trimmed to `d` decimals, rounded down. */
export const plain = (n: number, d = 2) => (Math.floor(Math.max(0, n) * 10 ** d) / 10 ** d).toString();

export type Field = { key: string; unit: string; label?: string; initial?: string; quick?: { label: string; value: string }[] };

export type Spec = {
  icon: string;
  /** A token logo shown instead of the icon. */
  logo?: string | null;
  title: string;
  sub: string;
  amount: string;
  dialog: {
    title: string;
    description: ReactNode;
    fields?: Field[];
    preview: (v: Record<string, number>) => [string, ReactNode][];
    /** Button label, e.g. "Repay". */
    confirm: string;
    /** Why this action can't run right now (shown instead of sending). */
    blocked?: string | null;
    hint?: ReactNode;
    /** Build the instructions from the raw inputs; throw an Error to show a validation message. */
    plan: (v: Record<string, string>) => Promise<TransactionInstruction[]>;
    /** Logged to this device's activity feed once the transaction lands. */
    activity?: (v: Record<string, string>) => ActivityNote;
  };
};

/** Parse a decimal input into token base units, or throw a readable error. */
export function units(v: string | undefined, decimals: number, what = "an amount"): BN {
  const s = (v ?? "").trim();
  if (!s || !/^\d*\.?\d*$/.test(s) || s === ".") throw new Error(`Enter ${what}.`);
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Use at most ${decimals} decimals.`);
  const u = new BN((whole || "0") + frac.padEnd(decimals, "0"));
  if (u.isZero()) throw new Error(`Enter ${what} above zero.`);
  return u;
}

/** Connect first, then act. */
export function ConnectFirst({ children, label = "Connect wallet to continue" }: { children?: ReactNode; label?: string }) {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  if (connected) return <>{children}</>;
  return (
    <button type="button" className="cx-btn" onClick={() => setVisible(true)}>
      <Icon name="lock" size={18} strokeWidth={1.9} /> {label}
    </button>
  );
}

export function ActionTile({ spec }: { spec: Spec }) {
  const ref = useRef<HTMLDialogElement>(null);
  const d = spec.dialog;
  const init = () => Object.fromEntries((d.fields ?? []).map((f) => [f.key, f.initial ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(init);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const send = useSend();
  const nums = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v) || 0]));
  const disabled = !!busy || !!d.blocked;

  const open = () => {
    setValues(init());
    setError(null);
    setDone(null);
    ref.current?.showModal();
  };

  const submit = async () => {
    if (disabled) return;
    setError(null);
    setDone(null);
    try {
      setBusy("Preparing…");
      const ixs = await d.plan(values);
      setDone(await send(ixs, setBusy, d.activity?.(values)));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" className="cx-tile" onClick={open}>
        {spec.logo ? (
          <img className="cx-tile-logo" src={spec.logo} alt="" />
        ) : (
          <span className="cx-tile-icon">
            <Icon name={spec.icon} size={24} strokeWidth={1.9} />
          </span>
        )}
        <span className="cx-tile-title">{spec.title}</span>
        <span className="cx-tile-sub">{spec.sub}</span>
        <span className="cx-tile-amount">{spec.amount}</span>
      </button>
      <dialog ref={ref} className="cx-dialog" aria-label={d.title} onClick={(e) => e.target === ref.current && !busy && ref.current?.close()}>
        <form method="dialog" className="cx-dialog-body" onSubmit={(e) => e.preventDefault()}>
          <div className="cx-dialog-head">
            <div>
              <h2>{d.title}</h2>
              <p>{d.description}</p>
            </div>
            <button type="button" className="cx-icon-btn" aria-label="Close" onClick={() => ref.current?.close()}>
              <Icon name="close" size={18} strokeWidth={2} />
            </button>
          </div>
          {(d.fields ?? []).map((f) => (
            <div key={f.key} className="cx-field">
              {f.label && <span className="cx-field-label">{f.label}</span>}
              <label className="cx-amount">
                <span className="cx-sr">
                  {f.label ?? "Amount"} in {f.unit}
                </span>
                <input
                  inputMode="decimal"
                  value={values[f.key] ?? ""}
                  placeholder="0"
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value.replace(/[^\d.]/g, "") }))}
                />
                <span>{f.unit}</span>
              </label>
              {f.quick && f.quick.length > 0 && (
                <div className="cx-quick">
                  {f.quick.map((q) => (
                    <button key={q.label} type="button" onClick={() => setValues((v) => ({ ...v, [f.key]: q.value }))}>
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <dl className="cx-kv">
            {d.preview(nums).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <ConnectFirst>
            <button type="button" className="cx-btn" aria-disabled={disabled || undefined} onClick={submit}>
              {busy ?? d.confirm}
            </button>
          </ConnectFirst>
          {error ? (
            <p className="cx-hint is-bad" role="alert">
              {error}
            </p>
          ) : done ? (
            <p className="cx-hint is-good" role="status">
              Done.{" "}
              <a href={explorerTx(done)} target="_blank" rel="noreferrer">
                View transaction
              </a>
            </p>
          ) : d.blocked ? (
            <p className="cx-hint">{d.blocked}</p>
          ) : (
            d.hint && <p className="cx-hint">{d.hint}</p>
          )}
        </form>
      </dialog>
    </>
  );
}

/** The card with its action tiles beside it; three or more tiles sit below it. */
export function Row({ children, specs }: { children?: ReactNode; specs: Spec[] }) {
  const tiles = specs.map((s) => <ActionTile key={s.title} spec={s} />);
  if (specs.length < 3) {
    return (
      <div className="cx-row">
        {children}
        {tiles}
      </div>
    );
  }
  return (
    <div className="cx-stack">
      {children && <div className="cx-row">{children}</div>}
      <div className="cx-row cx-row-even">{tiles}</div>
    </div>
  );
}

// ── Borrow ───────────────────────────────────────────────────────────────────────────────────────

const STALE_SECS = 600;

/** Why new borrowing (or withdrawing against debt) can't run right now; repay and add are always allowed. */
export function borrowBlock(m: Market): string | null {
  if (m.rule === "paused")
    return `Borrowing is paused while ${ticker(m.symbol)} is ${m.state === "Reopen" ? "reopening" : "in a corporate action"}; you can still repay or add collateral.`;
  if (m.priceAge > STALE_SECS) return `The ${ticker(m.symbol)} price is stale; the keeper refreshes it every 30 seconds. Try again shortly.`;
  if (m.rule === "safe" && !m.ruleClosure.days) return `The ${ticker(m.symbol)} closure has no known reopen time yet, so new borrowing waits for it.`;
  return null;
}

/** One line on which limit applies now and why. */
export function ruleText(m: Market): string {
  if (m.rule === "open") return `Limit ${pct(m.maxLtv)} LTV while ${ticker(m.symbol)} trades, until the Bell window opens 2 h before the close.`;
  if (m.rule === "paused") return borrowBlock(m) ?? "";
  const when = m.state === "Open" ? "The Bell window is open" : `${ticker(m.symbol)} is ${m.state.toLowerCase()}`;
  return `${when}: the limit is the ${m.ruleClosure.label.toLowerCase()} closure's safe ${pct(m.safeLtvByType[m.ruleClosure.type] ?? 0)} LTV, on debt with interest counted to the reopen (${m.ruleClosure.days ?? "?"} day${m.ruleClosure.days === 1 ? "" : "s"}).`;
}

/**
 * The loan actions for one market: borrow, repay, add collateral and withdraw. `only` picks tiles by
 * title, in that order. Limits mirror the program: max LTV while open, the closure-safe LTV while closed or halted.
 */
export function BorrowActions({
  market: m,
  position: p,
  stockBalance = 0,
  usdcBalance = 0,
  policy = null,
  quote = null,
  pool = null,
  only,
  children,
}: {
  market: Market;
  position?: Position;
  stockBalance?: number;
  usdcBalance?: number;
  /** The loan's Gap Cover for the upcoming closure, if bought. */
  policy?: { key: PublicKey; premium: number; auto: boolean } | null;
  /** The live Gap Cover quote (useCoverQuote). */
  quote?: { premium: number; utilAfter: number; safeLtv: number } | { error: string } | null;
  pool?: PoolView | null;
  only?: string[];
  children?: ReactNode;
}) {
  const { publicKey } = useWallet();
  const program = useProgram();
  const sym = ticker(m.symbol);
  const loan = LOAN_SYMBOL;
  const debt = p?.debt ?? 0;
  const tokens = p?.tokens ?? 0;
  const owner = () => {
    if (!publicKey) throw new Error("Connect a wallet first.");
    return publicKey;
  };

  const after = (newDebt: number, newTokens: number): [string, ReactNode][] => {
    const value = newTokens * m.price;
    const ltv = value > 0 ? newDebt / value : 0;
    return [
      ["New debt", `${num(Math.max(0, newDebt))} ${loan}`],
      ["New LTV", value > 0 ? pct(ltv) : "—"],
      ["Health factor", newDebt > 0 && value > 0 ? num((value * m.liqThreshold) / newDebt) : "No debt"],
      ["Limit now", m.rule === "paused" ? "Paused" : `${pct(m.borrowLtv)} LTV${m.rule === "open" ? "" : ` (closure-safe, ${m.ruleClosure.label.toLowerCase()})`}`],
    ];
  };

  const canBorrow = p ? p.canBorrow : 0;
  const freeTokens = debt > 0 ? Math.max(0, tokens - debt / (m.price * m.borrowLtv)) : tokens;

  const specs: Record<string, Spec> = {
    Repay: {
      icon: "repay",
      title: "Repay",
      sub: "Lower your debt",
      amount: `${num(debt)} ${loan}`,
      dialog: {
        title: `Repay ${sym} loan`,
        description: "Repaying is always allowed, in any market state. Anything above your debt is not taken.",
        fields: [
          {
            key: "a",
            unit: loan,
            initial: plain(debt, 6),
            quick: [
              { label: "Half", value: plain(debt / 2, 6) },
              // Interest accrues every second: a cent of headroom clears it all (only the debt is taken).
              { label: "All", value: plain(debt + 0.01, 6) },
            ],
          },
        ],
        preview: (v) => [...after(debt - (v.a ?? 0), tokens), ["Wallet", `${num(usdcBalance)} ${loan}`]],
        confirm: "Repay",
        blocked: debt <= 0 ? "This loan has no debt to repay." : null,
        plan: async (v) => ix.repay(program, owner(), m, units(v.a, USDC_DECIMALS)),
        activity: (v) => ({ icon: "repay", title: `Repaid ${sym} loan`, amount: `${num(Math.min(Number(v.a), debt))} ${loan}`, kind: "borrow" }),
      },
    },
    "Add collateral": {
      icon: "plus",
      title: "Add collateral",
      sub: `Deposit ${sym}`,
      amount: `${num(tokens, 4)} ${sym} in`,
      dialog: {
        title: `Add ${sym}`,
        description: "Adding collateral is always allowed, in any market state.",
        fields: [{ key: "a", unit: sym, quick: stockBalance > 0 ? [{ label: "All", value: plain(stockBalance, 6) }] : [] }],
        preview: (v) => [...after(debt, tokens + (v.a ?? 0)), ["Wallet", `${num(stockBalance, 4)} ${sym}`]],
        confirm: "Add collateral",
        blocked: stockBalance <= 0 ? `You have no ${sym}. Get test ${sym} on the Faucet page first.` : null,
        hint: <>Test {sym} tokens come from the Faucet page.</>,
        plan: async (v) => ix.deposit(program, owner(), m, units(v.a, STOCK_DECIMALS)),
        activity: (v) => ({ icon: "deposit", title: `Deposited ${sym}`, amount: `${num(Number(v.a), 4)} ${sym}`, kind: "borrow" }),
      },
    },
    Borrow: {
      icon: "cash",
      title: "Borrow",
      sub: m.rule === "open" ? "Up to your limit" : m.rule === "paused" ? "Paused" : "Closure-safe limit",
      amount: `${num(canBorrow, 0)} ${loan}`,
      dialog: {
        title: `Borrow ${loan} against ${sym}`,
        description: `${ruleText(m)} Price ${usd(m.price)} per ${sym}. Rate ${pct(m.borrowApr)} APR, variable.`,
        fields: [
          {
            key: "a",
            unit: loan,
            quick: [
              { label: "Half", value: plain(canBorrow / 2, 2) },
              { label: "Max", value: plain(canBorrow * 0.995, 2) },
            ],
          },
        ],
        preview: (v) => [...after(debt + (v.a ?? 0), tokens), ["Available in market", `${num(m.liquidity, 0)} ${loan}`]],
        confirm: "Borrow",
        blocked:
          borrowBlock(m) ??
          (tokens <= 0
            ? `Add ${sym} as collateral first.`
            : m.liquidity <= 0
              ? `There is no ${loan} left to lend in this market right now.`
              : canBorrow <= 0
                ? `Your loan is already at the ${pct(m.borrowLtv)} limit that applies right now.`
                : null),
        plan: async (v) => {
          const a = units(v.a, USDC_DECIMALS);
          if (Number(v.a) > canBorrow) throw new Error(`That's above your limit of ${num(canBorrow)} ${loan}.`);
          return ix.borrow(program, owner(), m, a, policy?.key ?? null);
        },
        activity: (v) => ({ icon: "cash", title: `Borrowed against ${sym}`, amount: `${num(Number(v.a))} ${loan}`, kind: "borrow" }),
      },
    },
    Withdraw: {
      icon: "withdraw",
      title: "Withdraw",
      sub: `${sym} collateral`,
      amount: `${num(tokens, 4)} ${sym}`,
      dialog: {
        title: `Withdraw ${sym}`,
        description: "Take collateral back while your LTV stays within the limit that applies right now.",
        fields: [{ key: "a", unit: sym, quick: [{ label: debt > 0 ? "Max" : "All", value: plain(freeTokens * (debt > 0 ? 0.995 : 1), 6) }] }],
        preview: (v) => after(debt, tokens - (v.a ?? 0)),
        confirm: "Withdraw",
        blocked: tokens <= 0 ? "There is no collateral in this loan." : debt > 0 ? borrowBlock(m) : null,
        plan: async (v) => ix.withdraw(program, owner(), m, units(v.a, STOCK_DECIMALS), policy?.key ?? null),
        activity: (v) => ({ icon: "withdraw", title: `Withdrew ${sym}`, amount: `${num(Number(v.a), 4)} ${sym}`, kind: "borrow" }),
      },
    },
  };
  // ── Gap Cover (CoverLogic.buyCover) ──
  const c = m.clock;
  const now = Date.now() / 1000;
  const q = quote && "premium" in quote ? quote : null;
  const coverBlock =
    policy
      ? `This loan is already covered for the ${c?.nextClosureType.toLowerCase() ?? "next"} closure.`
      : debt <= 0
        ? "Cover protects a loan with debt; borrow first."
        : !pool?.epoch
          ? "Cover opens once the pool opens the epoch for the next closure."
          : m.state !== "Open" || !c || now >= c.bellAt
            ? `Cover is sold while ${sym} trades, until the Bell deadline (15 minutes before the close).`
            : quote && "error" in quote
              ? quote.error
              : !q
                ? "Pricing the cover…"
                : null;
  const payFromDebt = !!q && usdcBalance < q.premium * 1.05;
  specs["Gap Cover"] = {
    icon: "shield",
    title: "Gap Cover",
    sub: policy ? (policy.auto ? "Applied by the Bell" : "You're covered") : "Keep your leverage",
    amount: policy ? "Covered" : q ? `${num(q.premium)} ${loan}` : "—",
    dialog: {
      title: `Gap Cover for ${sym}`,
      description:
        "Gap Cover lets you keep your LTV through the next closure: the limit stays at max LTV through the Bell window, and the Bell won't act on this loan. If the reopen gaps past your collateral, the Underwriter Pool pays the shortfall first.",
      preview: () => [
        ["Premium", q ? `${num(q.premium)} ${loan}${payFromDebt ? ", added to your debt" : ""}` : "—"],
        ["Covers", c ? `${c.nextClosureType} closure, ${et(c.nextCloseAt)} → ${et(c.nextReopenAt)}` : "—"],
        ["Buy before", c ? et(c.bellAt) : "The Bell deadline"],
        ["Pool use after", q ? pct(q.utilAfter) : "—"],
        ["Refunds", "None, even if you repay later"],
      ],
      confirm: "Buy Gap Cover",
      blocked: coverBlock,
      hint: q ? "The premium is priced from the closure's scenario set and the pool's capacity, live." : undefined,
      plan: async () => {
        if (!q || !pool) throw new Error("No quote yet; try again in a moment.");
        // 5% headroom over the quote; the program charges the live premium, never more than this.
        const max = new BN(Math.ceil(q.premium * 1.05 * 1e6) + 1);
        return poolIx.buyCover(program, owner(), m, pool, max, payFromDebt);
      },
      activity: () => ({ icon: "shield", title: `Gap Cover bought for ${sym}`, amount: `${num(q?.premium ?? 0)} ${loan}`, kind: "borrow" }),
    },
  };

  const titles = only ?? ["Borrow", "Repay", "Add collateral", "Withdraw"];
  return <Row specs={titles.map((t) => specs[t]!).filter(Boolean)}>{children}</Row>;
}
