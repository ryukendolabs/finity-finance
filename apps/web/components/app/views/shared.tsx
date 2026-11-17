"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ConnectFirst } from "../actions";
import { GradientCard, Note, Pill, num, pct } from "../ui";
import { useActivity } from "@/lib/activity";
import { lendExplorer } from "@/lib/lend";
import { explorerTx, ticker, tokenLogo } from "@/lib/protocol";
import { local } from "@/lib/time";
import { LOAN_SYMBOL, type MarketState, type Position } from "@/lib/solana";

export const STATE_TONE: Record<MarketState, "good" | "warn" | "bad" | "soft"> = {
  Open: "good",
  Extended: "warn",
  Closed: "soft",
  Reopen: "warn",
  Halted: "bad",
  "Corp. action": "bad",
};

/** Shown in place of wallet data before a wallet is connected. */
export function ConnectNote({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 14, justifyItems: "start" }}>
      <Note icon="lock">{children}</Note>
      <ConnectFirst label="Connect wallet" />
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <p className="cx-page-sub" style={{ margin: 0 }}>{what}…</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <Note icon="alert">
      Couldn&apos;t reach Solana ({error instanceof Error ? error.message : String(error)}). The app retries on its own.
    </Note>
  );
}

export function healthPill(p: Position, bell?: "safe" | "due" | "covered") {
  if (p.debt <= 0) return <Pill tone="soft">No debt</Pill>;
  if (bell === "covered") return <Pill tone="good">Covered</Pill>;
  if (bell === "due") return <Pill>Bell due</Pill>;
  if (p.liquidatable) return <Pill tone="bad">Liquidatable</Pill>;
  if (p.hf !== null && p.hf < 1.1) return <Pill tone="warn">At risk</Pill>;
  return <Pill tone="good">Safe</Pill>;
}

/** The loan card: debt, health factor and LTV. */
export function LoanCard({ p, bell }: { p: Position; bell?: "safe" | "due" | "covered" }) {
  return (
    <GradientCard
      logo={tokenLogo(p.market.symbol)}
      tag={ticker(p.market.symbol)}
      big={`${num(p.debt)} ${LOAN_SYMBOL}`}
      label="Health factor"
      value={`${p.hf === null ? "No debt" : num(p.hf)} · LTV ${pct(p.ltv, 1)}`}
      pill={healthPill(p, bell)}
    />
  );
}

export function NoLoans() {
  return (
    <Note icon="card">
      You have no loans yet.{" "}
      <Link href="/app/borrow" style={{ textDecoration: "underline" }}>
        Borrow USDC against your xStocks
      </Link>
      .
    </Note>
  );
}

/** This wallet's actions sent from this device, as activity rows with a link to each transaction. */
export function useActivityRows(address: string | undefined, kind?: string) {
  return useActivity(address, kind).map((a) => ({
    icon: a.icon,
    title: a.title,
    when: local(a.when),
    amount: a.amount,
    href: a.net === "lend" ? lendExplorer(a.sig, "tx") : (explorerTx(a.sig) ?? undefined),
  }));
}

export function NoActivity() {
  return <Note icon="clock">Nothing yet. Every action you take from this device shows up here, with a link to the transaction.</Note>;
}
