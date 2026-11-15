"use client";

import { Bar, GradientCard, H, InfoTile, KV, PageHead, Pill, StatBlock, Waterfall, pct, usd } from "../ui";
import { ErrorNote, Loading, STATE_TONE } from "./shared";
import { useApp } from "@/lib/app";
import { useOracleGuardian, usePool, useReserve } from "@/lib/solana";
import { ticker } from "@/lib/protocol";
import { useRiskConfig, useSeniorVault } from "@/lib/solana";
import { et } from "@/lib/time";

/** The build guide's product principles (§1.5), with what enforces each one on Solana today. */
const PRINCIPLES: [string, string, boolean][] = [
  ["P1", "Nobody is liquidated while their asset is closed, halted or in a corporate action", true],
  ["P2", "Repay and add collateral never fail, in any state", true],
  ["P3", "Senior lenders lose only after the pool and reserve are used up", true],
  ["P4", "A weekend price can lower collateral value, never raise it", true],
  ["P5", "Being fastest earns nothing in any liquidation", true],
  ["P6", "Every parameter and clearing price is on-chain", true],
  ["P7", "Keepers are untrusted; every keeper action is checked on-chain", true],
];

const TYPES: [number, string][] = [
  [1, "Overnight"],
  [2, "Weekend"],
  [3, "Holiday"],
];

export function RiskView() {
  const { markets, isLoading, error } = useApp();
  const { vault } = useSeniorVault(markets);
  const cfg = useRiskConfig().data;
  const loans = markets.reduce((a, m) => a + m.borrowed, 0);
  const stockPool = usePool("XNYS").data;
  const fundPool = usePool("USBANK").data;
  const poolFees = (stockPool?.nav ?? 0) + (fundPool?.nav ?? 0) + (vault?.poolFees ?? 0);
  const reserve = (useReserve().data?.cash ?? 0) + (vault?.treasuryFees ?? 0);
  const firstLoss = poolFees + reserve;
  const nextSigma = (m: (typeof markets)[number]) => m.sigmaByType[m.ruleClosure.type] ?? 0;
  const maxSigma = Math.max(0.0001, ...markets.map(nextSigma));
  const sets = markets.reduce((a, m) => a + Object.keys(m.sigmaByType).length, 0);
  const next = markets.find((m) => m.marketHours)?.clock;
  const og = useOracleGuardian().data;

  return (
    <>
      <PageHead
        title="Risk"
        sub="Every parameter, safe LTV and scenario set is on-chain. This page reads them live so anyone can check how the protocol is protected."
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H>Protocol</H>
            <div className="cx-row">
              <GradientCard
                tag="PROTOCOL"
                big={`${usd(loans, 0)} lent`}
                label="First-loss capital so far"
                value={`${usd(firstLoss, 2)}${loans ? ` (${pct(firstLoss / loans, 2)})` : ""}`}
                pill={<Pill tone="good">Live</Pill>}
              />
              <InfoTile icon="shield" title="Pool capacity" sub="Stock pool, this epoch" amount={stockPool?.epoch ? pct(stockPool.epoch.utilisation, 2) : "No epoch"} />
              <InfoTile icon="pie" title="Scenario sets" sub="Calibrated, on-chain" amount={String(sets)} />
              <InfoTile
                icon="clock"
                title="Next closure"
                sub={next?.current ? `${next.current.type} now` : next?.nextClosureType ?? "—"}
                amount={next?.current ? `Reopens ${et(next.current.reopenAt).split(", ")[1] ?? ""}` : et(next?.nextCloseAt).split(", ")[0] ?? "—"}
              />
            </div>
          </section>
          <section>
            <H right={<small>σ and safe LTV from the on-chain scenario sets (α = {cfg ? pct(cfg.alpha, 1) : "…"} quantile)</small>}>
              Closure risk by market
            </H>
            {error && !markets.length ? (
              <ErrorNote error={error} />
            ) : isLoading && !markets.length ? (
              <Loading what="Loading markets" />
            ) : (
              <div className="cx-table-wrap">
                <table className="cx-table">
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th style={{ minWidth: 150 }}>σ next closure</th>
                      {TYPES.map(([t, label]) => (
                        <th key={t} className="is-num">{label}-safe</th>
                      ))}
                      <th className="is-num">Max LTV</th>
                      <th className="is-num">Liq. threshold</th>
                      <th className="is-num">Limit now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {markets.map((m) => (
                      <tr key={m.symbol}>
                        <td data-label="Market" className="is-strong">
                          {ticker(m.symbol)} <Pill tone={STATE_TONE[m.state]}>{m.state}</Pill>
                        </td>
                        <td data-label="σ next closure">
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ flex: 1 }}>
                              <Bar value={nextSigma(m) / maxSigma} />
                            </div>
                            <span style={{ width: 52, textAlign: "right" }}>{pct(nextSigma(m), 2)}</span>
                          </div>
                        </td>
                        {TYPES.map(([t, label]) => (
                          <td key={t} data-label={`${label}-safe`} className="is-num">
                            {m.safeLtvByType[t] === undefined ? "—" : pct(m.safeLtvByType[t]!)}
                          </td>
                        ))}
                        <td data-label="Max LTV" className="is-num">{pct(m.maxLtv, 0)}</td>
                        <td data-label="Liq. threshold" className="is-num">{pct(m.liqThreshold, 0)}</td>
                        <td data-label="Limit now" className="is-num">{m.rule === "paused" ? "Paused" : pct(m.borrowLtv, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <H>Guarantees</H>
            <KV
              list
              rows={PRINCIPLES.map(([id, text, live]) => [
                <b key={id}>{id}</b>,
                <span key={text} style={{ fontWeight: 400, display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
                  {text} {live ? <Pill tone="good">Enforced</Pill> : <Pill tone="soft">Coming</Pill>}
                </span>,
              ])}
            />
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Loss cover" value={usd(firstLoss, 2)} chip="Before seniors" />
          <div>
            <H>Loss waterfall</H>
            <Waterfall
              layers={[
                { name: "Underwriter Pool", note: "Takes every reopen loss first", amount: usd(poolFees, 0), tone: "ink" },
                { name: "Protocol reserve", note: "Pays only after the pool", amount: usd(reserve, 2), tone: "tile" },
                { name: "Senior Vault", note: "Last in line", amount: usd(vault?.tvl ?? 0, 0), tone: "white" },
              ]}
            />
          </div>
          <div>
            <H>Prices and guardian</H>
            <KV
              rows={[
                ["Price signers", og ? (og.signers ? `${og.threshold} of ${og.signers} relayers, median` : "Not configured") : "…"],
                ["Keeper price pushes", og ? (og.keeperPrices ? "Allowed (bootstrap)" : "Off") : "…"],
                ["Borrowing", og?.borrowPaused ? <Pill key="b" tone="bad">Paused</Pill> : "Open"],
                ["Gap Cover sales", og?.coverPaused ? <Pill key="c" tone="bad">Paused</Pill> : "Open"],
                ["Max-LTV haircut", og?.haircut ? pct(og.haircut, 1) : "None"],
              ]}
            />
          </div>
          <div>
            <H>Risk parameters</H>
            <KV
              rows={
                cfg
                  ? [
                      ["Safe-LTV quantile α", pct(cfg.alpha, 2)],
                      ["Liquidation cost κ", pct(cfg.kappa, 1)],
                      ["Expected-shortfall level β", pct(cfg.beta, 1)],
                      ["Premium loading θ", pct(cfg.theta, 0)],
                      ["Cost of capital", `${pct(cfg.costOfCap, 0)} a year`],
                      ["Utilisation slope η", String(cfg.eta)],
                      ["Minimum premium", usd(cfg.minPremium)],
                      ["Max pool utilisation", pct(cfg.uMax, 0)],
                    ]
                  : [["Parameters", "Loading…"]]
              }
            />
          </div>
        </aside>
      </div>
    </>
  );
}
