"use client";

import { venueOf } from "@finity/solana";
import Link from "next/link";
import { BorrowActions } from "../actions";
import { ActivityList, Bar, H, KV, PageHead, StatBlock, StatRow, num, pct, usd } from "../ui";
import { ConnectNote, ErrorNote, LoanCard, Loading, NoActivity, NoLoans, useActivityRows } from "./shared";
import { useApp } from "@/lib/app";
import { ticker } from "@/lib/protocol";
import { USDC_MINT, useBalances, useCoverQuote, usePolicy, usePool, type Position, type Venue } from "@/lib/solana";
import { et } from "@/lib/time";

/** Above the closure-safe LTV on debt projected to the reopen (the Bell's test). */
export function bellDue(p: Position): boolean {
  const m = p.market;
  const c = m.clock;
  if (!c || p.debt <= 0 || p.value <= 0) return false;
  const days = c.nextReopenAt > c.nextCloseAt ? Math.ceil((c.nextReopenAt - c.nextCloseAt) / 86_400) : 0;
  const safe = m.safeLtvByType[m.ruleClosure.type] ?? m.maxLtv;
  return (p.debt * (1 + (m.borrowApr * days) / 365)) / p.value > safe;
}

/** The loan that matters most before the Bell: past the safe LTV first, then the highest LTV. */
function focusOf(loans: Position[]) {
  return [...loans].filter((l) => l.debt > 0).sort((a, b) => Number(bellDue(b)) - Number(bellDue(a)) || b.ltv - a.ltv)[0] ?? loans[0];
}

export function OverviewView() {
  const app = useApp();
  const focus = focusOf(app.loans);
  const m = focus?.market;
  const policy = usePolicy(m).data ?? null;
  const quote = useCoverQuote(m, focus).data ?? null;
  const pool = usePool((m ? venueOf(m.symbol) : "XNYS") as Venue).data ?? null;
  const bal = useBalances().data;
  const activity = useActivityRows(app.owner?.toBase58());
  const clock = app.markets.find((x) => x.marketHours)?.clock;
  const total = app.loans.reduce((a, l) => a + l.value, 0);
  const label = clock?.current ? clock.current.type : clock?.nextClosureType ?? "next";

  return (
    <>
      <PageHead
        title="Dashboard"
        sub={
          !clock
            ? "Reading the market clock…"
            : clock.current
              ? `Markets closed since ${et(clock.current.closeAt)} · Reopen ${et(clock.current.reopenAt)}`
              : `Next closure: ${et(clock.nextCloseAt)} · Bell deadline ${et(clock.bellAt)}`
        }
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H>Before the {label.toLowerCase()} Bell</H>
            {app.error && !app.markets.length ? (
              <ErrorNote error={app.error} />
            ) : !app.isConnected ? (
              <ConnectNote>Connect a wallet to see your loans and what each one needs before the Bell.</ConnectNote>
            ) : app.loansLoading ? (
              <Loading what="Loading your loans" />
            ) : !focus ? (
              <NoLoans />
            ) : (
              <BorrowActions
                market={focus.market}
                position={focus}
                usdcBalance={bal?.byMint[USDC_MINT.toBase58()] ?? 0}
                stockBalance={bal?.byMint[focus.market.mint.toBase58()] ?? 0}
                policy={policy}
                quote={quote}
                pool={pool}
                only={["Repay", "Gap Cover"]}
              >
                <LoanCard p={focus} bell={policy ? "covered" : bellDue(focus) ? "due" : "safe"} />
              </BorrowActions>
            )}
          </section>
          <section>
            <H right={<span className="cx-chip">Newest first</span>}>Recent activity</H>
            {activity.length ? <ActivityList items={activity.slice(0, 6)} /> : <NoActivity />}
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Health factor" value={focus?.hf != null ? num(focus.hf) : "—"} chip={focus ? ticker(focus.market.symbol) : "No loan"} />
          {focus && (
            <div>
              <KV
                rows={[
                  ["LTV now", pct(focus.ltv, 1)],
                  [`${focus.market.ruleClosure.label}-safe LTV`, pct(focus.market.safeLtvByType[focus.market.ruleClosure.type] ?? 0, 1)],
                  ["Liquidation at", pct(focus.market.liqThreshold, 0)],
                ]}
              />
              <div style={{ marginTop: 14 }}>
                <Bar value={focus.market.liqThreshold ? focus.ltv / focus.market.liqThreshold : 0} />
              </div>
            </div>
          )}
          <div>
            <H right={<Link href="/app/borrow"><small>View all</small></Link>}>Your markets</H>
            {app.loans.length ? (
              <div className="cx-stat-rows">
                {app.loans.map((p) => (
                  <StatRow
                    key={p.key.toBase58()}
                    big={num(p.value, 0)}
                    unit="USD"
                    sub={`${num(p.tokens, 4)} ${ticker(p.market.symbol)}`}
                    tag={p.liquidatable ? "At risk" : bellDue(p) ? "Bell due" : "Safe"}
                  />
                ))}
              </div>
            ) : (
              <p className="cx-page-sub" style={{ margin: 0 }}>No collateral yet.</p>
            )}
          </div>
          <p className="cx-page-sub" style={{ margin: 0 }}>Total collateral {usd(total, 0)}</p>
        </aside>
      </div>
    </>
  );
}
