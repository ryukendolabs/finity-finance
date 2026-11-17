"use client";

import { useEffect, useState } from "react";
import { useMarkets } from "@/lib/solana";

/** While the market is closed real prices don't move, so the strip shows a labelled simulation: each symbol
 *  random-walks a small change (kept within ±3%) every few seconds. Real prices take over once the market opens. */
const SIM_STEP_MS = 2500;
const SIM_LIMIT = 0.03;

function useSimulatedChanges(symbols: string[], active: boolean) {
  const [sim, setSim] = useState<Record<string, number>>({});
  const key = symbols.join(",");
  useEffect(() => {
    if (!active) return;
    const step = () =>
      setSim((prev) => {
        const next: Record<string, number> = {};
        for (const s of key.split(",")) {
          const cur = prev[s] ?? (Math.random() - 0.5) * 0.02;
          const moved = cur + (Math.random() - 0.5) * 0.004;
          next[s] = Math.max(-SIM_LIMIT, Math.min(SIM_LIMIT, moved));
        }
        return next;
      });
    step();
    const id = setInterval(step, SIM_STEP_MS);
    return () => clearInterval(id);
  }, [key, active]);
  return active ? sim : null;
}

const usd = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** The scrolling price strip under the top bar: each stock as its xStock ticker, price and change since the last
 *  close. The list is drawn twice so the loop is seamless; it pauses on hover and stays still for reduced motion. */
export function Ticker() {
  const { markets } = useMarkets();
  const live = markets.filter((m) => m.marketHours && m.price > 0);
  // Simulate while every market is closed, or whenever no real price has moved since the last close.
  const flat = live.every((m) => {
    const ref = m.clock?.refPrice ?? 0;
    return !(ref > 0) || Math.abs(m.price / ref - 1) < 0.0005;
  });
  const closed = live.length > 0 && (flat || live.every((m) => m.state !== "Open" && m.state !== "Extended"));
  const sim = useSimulatedChanges(
    live.map((m) => m.symbol),
    closed,
  );
  const rows = live.map((m) => {
    const ref = m.clock?.refPrice ?? 0;
    const simChange = sim?.[m.symbol];
    if (simChange !== undefined)
      return {
        symbol: `${m.symbol}x`,
        price: m.price * (1 + simChange),
        change: simChange,
      };
    return {
      symbol: `${m.symbol}x`,
      price: m.price,
      change: ref > 0 ? m.price / ref - 1 : null,
    };
  });
  if (!rows.length) return <div className="cx-ticker" aria-hidden="true" />;
  // Each half holds the list twice, so it is wider than any screen and the loop never shows a gap.
  const items = (copy: number) => [
    ...(sim
      ? [
          <span key={`${copy}-sim`} className="cx-ticker-item cx-ticker-sim">
            Simulated · market closed
          </span>,
        ]
      : []),
    ...[...rows, ...rows].map((r, i) => (
      <span key={`${copy}-${i}`} className="cx-ticker-item">
        <strong>{r.symbol}</strong> {usd(r.price)}
        {r.change !== null && (
          <em className={Math.abs(r.change) < 0.0005 ? undefined : r.change > 0 ? "is-up" : "is-down"}>
            {r.change >= 0.0005 ? "+" : ""}
            {(Math.abs(r.change) < 0.0005 ? 0 : r.change * 100).toFixed(1)}%
          </em>
        )}
      </span>
    )),
  ];
  return (
    <div className="cx-ticker" role="marquee" aria-label="Stock prices">
      <div className="cx-ticker-track">
        <div className="cx-ticker-set">{items(0)}</div>
        <div className="cx-ticker-set" aria-hidden="true">
          {items(1)}
        </div>
      </div>
    </div>
  );
}
