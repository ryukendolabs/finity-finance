"use client";

import { FAUCET_MAX_WHOLE, USDC_DECIMALS } from "@finity/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { ActionTile, ConnectFirst, plain } from "../actions";
import { GradientCard, H, KV, Note, PageHead, Pill, StatBlock, num } from "../ui";
import { useApp } from "@/lib/app";
import { useLendWallet } from "@/lib/lend";
import { tokenLogo } from "@/lib/protocol";
import { LOAN_SYMBOL, USDC_MINT, ix, useBalances, useProgram } from "@/lib/solana";

/** Test USDC for underwriting and auctions. */
function UsdcTile({ held }: { held: number | undefined }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  return (
    <ActionTile
      spec={{
        icon: "cash",
        logo: tokenLogo(LOAN_SYMBOL),
        title: `Test ${LOAN_SYMBOL}`,
        sub: "For underwriting and auctions",
        amount: held === undefined ? "Ready" : `${num(held, 2)} held`,
        dialog: {
          title: `Get test ${LOAN_SYMBOL}`,
          description: `Test tokens with no value, for the Underwrite and Auctions pages. Up to ${num(FAUCET_MAX_WHOLE, 0)} per request. The network fee is on us.`,
          fields: [{ key: "a", unit: LOAN_SYMBOL, initial: "1000", quick: [{ label: "Max", value: plain(FAUCET_MAX_WHOLE, 0) }] }],
          preview: (v) => [
            ["You receive", `${num(v.a ?? 0, 2)} test ${LOAN_SYMBOL}`],
            ["Wallet balance", held === undefined ? "—" : `${num(held, 2)} test ${LOAN_SYMBOL}`],
          ],
          confirm: `Get test ${LOAN_SYMBOL}`,
          plan: async (v) => {
            const a = Number(v.a);
            if (!(a > 0)) throw new Error("Enter an amount above zero.");
            if (a > FAUCET_MAX_WHOLE) throw new Error(`The faucet gives at most ${FAUCET_MAX_WHOLE} per request.`);
            if (!publicKey) throw new Error("Connect a wallet first.");
            return ix.faucet(program, publicKey, USDC_MINT, a, USDC_DECIMALS);
          },
        },
      }}
    />
  );
}

export function FaucetView() {
  const { isConnected } = useApp();
  const sol = useLendWallet().data?.sol;
  const bal = useBalances().data;

  return (
    <>
      <PageHead title="Faucet" sub="Test USDC for the Underwrite and Auctions pages. Borrowing uses real xStocks and USDC on Solana mainnet." />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H>1. Borrowing on mainnet</H>
            <div className="cx-row">
              <GradientCard
                tag="SOL"
                big={!isConnected ? "Not connected" : sol === undefined ? "…" : `${num(sol, 4)} SOL`}
                label="Your wallet's SOL pays mainnet fees"
                value="Fees ~0.00002 SOL · account deposits ~0.002 SOL"
                pill={sol !== undefined && sol >= 0.01 ? <Pill tone="good">Ready</Pill> : <Pill>Needs SOL</Pill>}
              />
            </div>
            <div style={{ marginTop: 18, display: "grid", gap: 14, justifyItems: "start" }}>
              {!isConnected ? (
                <ConnectFirst label="Connect wallet" />
              ) : (
                <Note icon="cash">
                  Borrowing needs xStocks (AAPLx, NVDAx, …) as collateral and a little SOL for fees; there are no test tokens for it.{" "}
                  <Link href="/app/borrow" style={{ textDecoration: "underline" }}>
                    Go to Borrow
                  </Link>
                  .
                </Note>
              )}
            </div>
          </section>
          <section>
            <H right={<small>For underwriting and auctions</small>}>2. Test USDC</H>
            <div className="cx-row">
              <UsdcTile held={bal ? (bal.byMint[USDC_MINT.toBase58()] ?? 0) : undefined} />
            </div>
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Fees" value={sol === undefined ? "—" : num(sol, 4)} chip="SOL" />
          <KV
            rows={[
              ["Test USDC", `Up to ${num(FAUCET_MAX_WHOLE, 0)} per request`],
              ["Its value", "None: underwriting and auctions only"],
              ["Borrowing", "Real xStocks and USDC"],
            ]}
          />
          <Note icon="alert">Phantom, Solflare and Backpack all work. Your wallet signs; the app sends each transaction to the right place.</Note>
        </aside>
      </div>
    </>
  );
}
