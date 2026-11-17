"use client";

import { LEND_PROGRAM_ID } from "@finity/solana/lend";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { ConnectFirst } from "../actions";
import { H, KV, Note, PageHead, Pill, StatBlock, num, pct, usd } from "../ui";
import { ErrorNote, Loading } from "./shared";
import { LEND_ADDR, LEND_LOAN, lendExplorer, useLendLoans, useLendMarkets } from "@/lib/lend";
import { tokenLogo } from "@/lib/protocol";

const ago = (s: number) => (s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const link = (a: string, text: string) => (
  <a href={lendExplorer(a)} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
    {text}
  </a>
);

export function MainnetView() {
  const { connected } = useWallet();
  const lend = useLendMarkets();
  const markets = lend.data?.markets ?? [];
  const pool = lend.data?.pool;
  const { loans } = useLendLoans(lend.data?.markets);
  const now = Date.now() / 1000;
  const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

  return (
    <>
      <PageHead
        title="Mainnet"
        sub="Finity Lend on Solana mainnet: USDC loans against xStocks, from one lending pool, opened, borrowed against and repaid with your own wallet."
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small>{link(LEND_PROGRAM_ID.toBase58(), "Program ↗")}</small>}>Markets on mainnet</H>
            {lend.error && !lend.data ? (
              <ErrorNote error={lend.error} />
            ) : lend.isLoading ? (
              <Loading what="Reading mainnet" />
            ) : !lend.data ? (
              <Note icon="clock">The markets open on mainnet soon.</Note>
            ) : (
              <KV
                list
                rows={markets.map((m) => [
                  <span key="k" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                    {tokenLogo(m.base) && <img src={tokenLogo(m.base)!} alt="" width={20} height={20} />}
                    {link(m.vault.toBase58(), m.symbol)}
                    <Pill tone={m.paused ? "soft" : "good"}>{m.paused ? "paused" : "borrowing"}</Pill>
                  </span>,
                  <span key="v">
                    {m.paused ? "no price" : usd(m.price)} · max LTV {pct(m.maxLtv, 0)} · {num(m.collateral, 2)} held
                  </span>,
                ])}
              />
            )}
          </section>

          <section>
            <H>Your loans on mainnet</H>
            {!connected ? (
              <ConnectFirst label="Connect wallet to see your loans" />
            ) : !loans.length ? (
              <Note icon="card">
                No loans yet.{" "}
                <Link href="/app/borrow" style={{ textDecoration: "underline" }}>
                  Open one on the Borrow page
                </Link>
                .
              </Note>
            ) : (
              <KV
                list
                rows={loans.map((l) => [
                  <span key="k">{link(l.key.toBase58(), l.market.symbol)}</span>,
                  <span key="v">
                    {num(l.collateral, 4)} {l.market.symbol} · debt {num(l.debt)} {LEND_LOAN} · LTV {pct(l.ltv, 1)}
                  </span>,
                ])}
              />
            )}
          </section>
          <Note icon="lock">
            Collateral and loans are real token transfers between your wallet and the contract&apos;s vaults. Borrowing checks the market&apos;s max
            LTV against a price no more than 20 minutes old; repaying works at any time, and paying a loan off returns all of its collateral.
          </Note>
        </div>

        <aside className="cx-aside">
          <StatBlock label="Pool size" value={pool ? usd(pool.supplied, 0) : "—"} chip={pool ? `${pool.loans} open loans` : "Mainnet"} />
          <KV
            rows={[
              ["Program", link(LEND_PROGRAM_ID.toBase58(), short(LEND_PROGRAM_ID.toBase58()))],
              ["Markets account", LEND_ADDR ? link(LEND_ADDR.markets.toBase58(), short(LEND_ADDR.markets.toBase58())) : "—"],
              ["Markets", String(markets.length || "—")],
              ["Prices updated", pool?.priceAt ? ago(now - pool.priceAt) : "Not yet"],
            ]}
          />
          <div>
            <H>Live on mainnet</H>
            <KV rows={[["Open a loan", "Yes"], ["Borrow", "Yes"], ["Repay", "Yes"], ["Prices", "Every 15 min, US market hours"]]} />
          </div>
          <Note icon="external">Your wallet signs real mainnet transactions here: a small SOL fee each, plus refundable account deposits.</Note>
        </aside>
      </div>
    </>
  );
}
