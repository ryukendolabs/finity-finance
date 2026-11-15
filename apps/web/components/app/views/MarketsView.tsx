"use client";

import Link from "next/link";
import { GradientCard, H, KV, Note, PageHead, Pill, StatBlock, pct, usd } from "../ui";
import { ErrorNote, Loading, STATE_TONE } from "./shared";
import { useApp } from "@/lib/app";
import { explorerAddress, ticker, tokenLogo } from "@/lib/protocol";
import { et, until } from "@/lib/time";

const age = (s: number) => (s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);

export function MarketsView({ q }: { q: string }) {
  const { markets, liquidity, isLoading, error } = useApp();
  const query = q.trim().toLowerCase();
  const shown = query
    ? markets.filter((m) => m.symbol.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
    : markets;
  const collateral = markets.reduce((a, m) => a + m.collateralValue, 0);
  const supplied = markets.reduce((a, m) => a + m.supplied, 0);
  const borrowed = markets.reduce((a, m) => a + m.borrowed, 0);
  const equity = markets.find((m) => m.marketHours);
  const fund = markets.find((m) => !m.marketHours);
  const c = equity?.clock;
  const freshest = markets.length ? Math.min(...markets.map((m) => m.priceAge)) : null;

  return (
    <>
      <PageHead
        title="Markets"
        sub="Isolated markets for tokenized stocks and a Treasury money fund on Solana devnet. Borrow limits follow each asset's market clock."
        right={query ? <Link className="cx-chip" href="/app/markets">Clear “{q}” ×</Link> : undefined}
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small>{shown.length} of {markets.length}</small>}>All markets</H>
            {error && !markets.length ? (
              <ErrorNote error={error} />
            ) : isLoading && !markets.length ? (
              <Loading what="Loading markets" />
            ) : shown.length === 0 ? (
              <Note icon="search">No market matches “{q}”. Try a ticker like NVDA or TBILL.</Note>
            ) : (
              <div className="cx-cards">
                {shown.map((m) => (
                  <Link key={m.symbol} href={`/app/borrow?m=${m.symbol}`} className="cx-card-btn" aria-label={`Borrow against ${ticker(m.symbol)}`}>
                    <GradientCard
                      logo={tokenLogo(m.symbol)}
                      tag={ticker(m.symbol)}
                      big={m.kind === "Treasury fund" ? `NAV ${usd(m.price, 2)}` : usd(m.price)}
                      label={`Max LTV ${pct(m.maxLtv, 0)} · Limit now ${m.rule === "paused" ? "paused" : pct(m.borrowLtv, 1)}`}
                      value={`Borrow ${pct(m.borrowApr, 2)} APR · Supply ${pct(m.supplyApr, 2)}`}
                      pill={<Pill tone={STATE_TONE[m.state]}>{m.state}</Pill>}
                    />
                  </Link>
                ))}
              </div>
            )}
          </section>
          <Note icon="lock">
            From the Bell window (2 h before each close) until the reopen, new borrowing is capped at the closure&apos;s safe LTV on
            debt projected to the reopen, and collateral is valued at the lower of the live price and the close. Nobody is
            liquidated while a market is closed; repaying and adding collateral always work.
          </Note>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Total supplied" value={supplied >= 1e6 ? `$${(supplied / 1e6).toFixed(2)}M` : usd(supplied, 0)} chip="All markets" />
          <KV
            rows={[
              ["Borrowed", usd(borrowed, 0)],
              ["Left to lend", usd(liquidity, 0)],
              ["Utilisation", supplied > 0 ? pct(borrowed / supplied, 1) : "—"],
              ["Collateral posted", usd(collateral, 0)],
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
                      ["Close price", usd(equity?.clock?.refPrice ?? 0)],
                    ]
                  : [
                      ["Bell window", `${et(c?.bellWindowAt)}${until(c?.bellWindowAt) ? ` (in ${until(c?.bellWindowAt)})` : ""}`],
                      ["Bell deadline", et(c?.bellAt)],
                      ["Close", `${et(c?.nextCloseAt)}, ${c?.nextClosureType.toLowerCase() ?? ""}`],
                    ]) as [string, string][]),
                ["T-Bill fund", fund ? <Pill key="f" tone={STATE_TONE[fund.state]}>{fund.state}</Pill> : "—"],
                ["Prices updated", freshest === null ? "—" : age(freshest)],
              ]}
            />
          </div>
          <Note icon="external">
            Every market is a Solana account.{" "}
            {equity && (
              <a href={explorerAddress(equity.key.toBase58())} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                See {equity.symbol} on the explorer
              </a>
            )}
          </Note>
        </aside>
      </div>
    </>
  );
}
