"use client";

import Link from "next/link";
import { GradientCard, H, KV, Note, PageHead, Pill, StatBlock, pct, usd } from "../ui";
import { ErrorNote, Loading, STATE_TONE } from "./shared";
import { useApp } from "@/lib/app";
import { LEND_ADDR, lendExplorer, useLendMarkets } from "@/lib/lend";
import { ticker, tokenLogo } from "@/lib/protocol";
import { et, until } from "@/lib/time";

const age = (s: number) => (s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : usd(n, 0));

export function MarketsView({ q }: { q: string }) {
  const lend = useLendMarkets();
  const clock = useApp();
  const markets = lend.data?.markets ?? [];
  const pool = lend.data?.pool;
  const query = q.trim().toLowerCase();
  const shown = query
    ? markets.filter((m) => m.symbol.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
    : markets;
  const equity = clock.markets.find((m) => m.marketHours);
  const c = equity?.clock;
  const now = Date.now() / 1000;

  return (
    <>
      <PageHead
        title="Markets"
        sub="Borrow USDC against tokenized stocks (xStocks), live on Solana mainnet. Each market lends up to its max LTV while US markets are open."
        right={query ? <Link className="cx-chip" href="/app/markets">Clear “{q}” ×</Link> : undefined}
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small>{shown.length} of {markets.length}</small>}>All markets</H>
            {lend.error && !markets.length ? (
              <ErrorNote error={lend.error} />
            ) : lend.isLoading ? (
              <Loading what="Loading markets" />
            ) : !LEND_ADDR || !lend.data ? (
              <Note icon="clock">The markets open soon.</Note>
            ) : shown.length === 0 ? (
              <Note icon="search">No market matches “{q}”. Try a ticker like NVDA or TSLA.</Note>
            ) : (
              <div className="cx-cards">
                {shown.map((m) => (
                  <Link key={m.symbol} href={`/app/borrow?m=${m.symbol}`} className="cx-card-btn" aria-label={`Borrow against ${ticker(m.symbol)}`}>
                    <GradientCard
                      logo={tokenLogo(m.base)}
                      tag={ticker(m.symbol)}
                      big={m.paused ? "Price paused" : m.kind === "Treasury fund" ? `NAV ${usd(m.price, 2)}` : usd(m.price)}
                      label={`Max LTV ${pct(m.maxLtv, 0)}`}
                      value={`${usd(m.collateralValue, 0)} collateral posted`}
                      pill={<Pill tone={m.paused ? "soft" : "good"}>{m.paused ? "Paused" : "Borrowing"}</Pill>}
                    />
                  </Link>
                ))}
              </div>
            )}
          </section>
          <Note icon="lock">
            Prices are posted to the contract every 15 minutes while US markets are open. Outside those hours, and whenever a price is
            more than 20 minutes old, new borrowing waits; repaying always works, and paying a loan off returns all its collateral.
          </Note>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Pool size" value={pool ? money(pool.supplied) : "—"} chip="All markets" />
          <KV
            rows={[
              ["Borrowed", pool ? usd(pool.lent, 0) : "—"],
              ["Left to lend", pool ? usd(pool.cash, 0) : "—"],
              ["Utilisation", pool && pool.supplied > 0 ? pct(pool.utilisation, 1) : "—"],
              ["Collateral posted", pool ? usd(pool.collateralValue, 0) : "—"],
            ]}
          />
          <div>
            <H>Market clock</H>
            <KV
              rows={[
                ["US stocks", equity ? <Pill key="s" tone={STATE_TONE[equity.state]}>{equity.state}</Pill> : "—"],
                ...((c?.current
                  ? [
                      ["Closure", `${c.current.type}, since ${et(c.current.closeAt)}`],
                      ["Reopens", c.current.reopenAt ? `${et(c.current.reopenAt)} (${until(c.current.reopenAt) ?? "now"})` : "Unknown"],
                    ]
                  : [["Close", c ? `${et(c.nextCloseAt)}, ${c.nextClosureType.toLowerCase()}` : "—"]]) as [string, string][]),
                ["Prices updated", pool?.priceAt ? age(now - pool.priceAt) : "Not yet"],
              ]}
            />
          </div>
          {LEND_ADDR && (
            <Note icon="external">
              Every market lives in one Solana account.{" "}
              <a href={lendExplorer(LEND_ADDR.markets.toBase58())} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                See it on the explorer
              </a>
            </Note>
          )}
        </aside>
      </div>
    </>
  );
}
