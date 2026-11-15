"use client";

import { useState } from "react";
import { BorrowActions } from "../actions";
import { GradientCard, H, KV, Note, PageHead, Pill, StatBlock, num, pct, usd } from "../ui";
import { ConnectNote, ErrorNote, LoanCard, Loading, NoLoans, STATE_TONE } from "./shared";
import { useApp } from "@/lib/app";
import { ticker, tokenLogo } from "@/lib/protocol";
import { et } from "@/lib/time";
import { LOAN_SYMBOL, USDC_MINT, useBalances, useCoverQuote, usePolicy, usePool, type Position, type Venue } from "@/lib/solana";
import { venueOf } from "@finity/solana";

function LoanSection({ p, balances }: { p: Position; balances: Record<string, number> }) {
  const m = p.market;
  const policy = usePolicy(m).data ?? null;
  const quote = useCoverQuote(m, p).data ?? null;
  const pool = usePool(venueOf(m.symbol) as Venue).data ?? null;
  const days = m.clock?.nextReopenAt && m.clock.nextCloseAt ? Math.ceil((m.clock.nextReopenAt - m.clock.nextCloseAt) / 86_400) : 0;
  const safe = m.safeLtvByType[m.ruleClosure.type] ?? m.maxLtv;
  const projected = p.debt * (1 + (m.borrowApr * days) / 365);
  const bell = policy ? "covered" : p.debt > 0 && p.value > 0 && projected / p.value > safe ? "due" : "safe";
  const needs = bell === "due";
  return (
    <section>
      <H right={<small>{num(p.tokens, 4)} {ticker(m.symbol)} · {usd(p.value, 0)} collateral</small>}>{m.name} loan</H>
      <BorrowActions
        market={m}
        position={p}
        stockBalance={balances[m.mint.toBase58()] ?? 0}
        usdcBalance={balances[USDC_MINT.toBase58()] ?? 0}
        policy={policy}
        quote={quote}
        pool={pool}
        only={needs ? ["Repay", "Add collateral", "Gap Cover"] : ["Borrow", "Repay", "Add collateral", "Withdraw", "Gap Cover"]}
      >
        <LoanCard p={p} bell={bell} />
      </BorrowActions>
      {needs && (
        <div style={{ marginTop: 16 }}>
          <Note icon="clock">
            The Bell: this loan is above the {m.ruleClosure.label.toLowerCase()} closure&apos;s safe {pct(safe, 1)} LTV on debt projected to
            the reopen. Repay, add collateral, or buy Gap Cover before {m.clock ? et(m.clock.bellAt) : "the Bell deadline"}; after it, the
            Bell auto-covers the loan (premium added to debt) when it&apos;s within the coverable limit.
          </Note>
        </div>
      )}
      {p.liquidatable && (
        <div style={{ marginTop: 16 }}>
          <Note icon="alert">
            This loan is over its {pct(m.liqThreshold, 0)} liquidation line. Repay or add collateral now: the keeper can repay up to half
            of it and take {ticker(m.symbol)} worth that plus a {pct(m.liqBonus, 1)} bonus.
          </Note>
        </div>
      )}
    </section>
  );
}

export function BorrowView({ m: initial = "" }: { m?: string }) {
  const app = useApp();
  const balances = useBalances().data?.byMint ?? {};
  const debt = app.loans.reduce((a, l) => a + l.debt, 0);
  const open = new Set(app.loans.map((l) => l.market.symbol));
  const choices = app.markets.filter((m) => !open.has(m.symbol));
  const [pick, setPick] = useState<string | null>(initial || null);
  const chosen = choices.find((m) => m.symbol === pick) ?? choices[0];

  return (
    <>
      <PageHead
        title="Borrow"
        sub="Borrow test USDC against tokenized stocks and a T-Bill fund. While a market is closed, the closure-safe limit applies."
      />
      <div className="cx-grid">
        <div className="cx-col">
          {app.error && !app.markets.length ? (
            <ErrorNote error={app.error} />
          ) : !app.isConnected ? (
            <section>
              <H>Your loans</H>
              <ConnectNote>Connect a Solana wallet (set to devnet) to open a loan or manage the ones you have.</ConnectNote>
            </section>
          ) : app.loansLoading || (app.isLoading && !app.markets.length) ? (
            <Loading what="Loading your loans" />
          ) : app.loans.length === 0 ? (
            <section>
              <H>Your loans</H>
              <NoLoans />
            </section>
          ) : (
            app.loans.map((l) => <LoanSection key={l.key.toBase58()} p={l} balances={balances} />)
          )}
          {app.isConnected && chosen && (
            <section>
              <H right={<small>Add collateral, then borrow</small>}>Open a loan</H>
              <div className="cx-seg" role="group" aria-label="Market" style={{ marginBottom: 18 }}>
                {choices.map((m) => (
                  <button key={m.symbol} type="button" aria-pressed={m.symbol === chosen.symbol} onClick={() => setPick(m.symbol)}>
                    {ticker(m.symbol)}
                  </button>
                ))}
              </div>
              <BorrowActions
                key={chosen.symbol}
                market={chosen}
                stockBalance={balances[chosen.mint.toBase58()] ?? 0}
                usdcBalance={balances[USDC_MINT.toBase58()] ?? 0}
                only={["Add collateral"]}
              >
                <GradientCard
                  logo={tokenLogo(chosen.symbol)}
                  tag={ticker(chosen.symbol)}
                  big={usd(chosen.price)}
                  label={`Borrow up to ${pct(chosen.borrowLtv, 0)} LTV now`}
                  value={`You hold ${num(balances[chosen.mint.toBase58()] ?? 0, 4)} ${ticker(chosen.symbol)}`}
                  pill={<Pill tone={STATE_TONE[chosen.state]}>{chosen.state}</Pill>}
                />
              </BorrowActions>
            </section>
          )}
        </div>
        <aside className="cx-aside">
          <StatBlock label="Total debt" value={usd(debt, 0)} chip={`${app.loans.filter((l) => l.debt > 0).length} loans`} />
          {app.loans.length > 0 && (
            <div>
              <H>Health factor</H>
              <KV rows={app.loans.map((p) => [ticker(p.market.symbol), p.hf === null ? "No debt" : `${num(p.hf)} · LTV ${pct(p.ltv, 1)}`])} />
            </div>
          )}
          <div>
            <H>How it works</H>
            <KV
              rows={[
                ["Loan token", `Test ${LOAN_SYMBOL}`],
                ["Interest", "None on devnet"],
                ["Health below 1", "Liquidatable"],
                ["Per liquidation", "Up to half the debt"],
              ]}
            />
          </div>
          <Note icon="alert">Each transaction needs a little devnet SOL for the fee. Get it from faucet.solana.com.</Note>
        </aside>
      </div>
    </>
  );
}
