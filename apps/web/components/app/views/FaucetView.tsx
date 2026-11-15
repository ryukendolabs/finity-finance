"use client";

import { FAUCET_MAX_WHOLE, STOCK_DECIMALS, USDC_DECIMALS } from "@finity/solana";
import type { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { ActionTile, ConnectFirst, plain } from "../actions";
import { GradientCard, H, KV, Note, PageHead, Pill, StatBlock, num } from "../ui";
import { useApp } from "@/lib/app";
import { CLUSTER_NAME, ticker, tokenLogo } from "@/lib/protocol";
import { LOAN_SYMBOL, USDC_MINT, ix, useBalances, useProgram } from "@/lib/solana";

type Tok = { symbol: string; mint: PublicKey; decimals: number; per: number; note: string };

function DripTile({ t, held }: { t: Tok; held: number | undefined }) {
  const program = useProgram();
  const { publicKey } = useWallet();
  return (
    <ActionTile
      spec={{
        icon: t.symbol === LOAN_SYMBOL ? "cash" : "deposit",
        logo: tokenLogo(t.symbol),
        title: ticker(t.symbol),
        sub: t.note,
        amount: held === undefined ? "Ready" : `${num(held, t.symbol === LOAN_SYMBOL ? 2 : 4)} held`,
        dialog: {
          title: `Get test ${ticker(t.symbol)}`,
          description: `Test tokens on ${CLUSTER_NAME}, with no value. Up to ${num(FAUCET_MAX_WHOLE, 0)} per request.`,
          fields: [{ key: "a", unit: ticker(t.symbol), initial: String(t.per), quick: [{ label: "Max", value: plain(FAUCET_MAX_WHOLE, 0) }] }],
          preview: (v) => [
            ["You receive", `${num(v.a ?? 0, 2)} ${ticker(t.symbol)}`],
            ["Wallet balance", held === undefined ? "—" : `${num(held, 4)} ${ticker(t.symbol)}`],
          ],
          confirm: `Get ${ticker(t.symbol)}`,
          plan: async (v) => {
            const a = Number(v.a);
            if (!(a > 0)) throw new Error("Enter an amount above zero.");
            if (a > FAUCET_MAX_WHOLE) throw new Error(`The faucet gives at most ${FAUCET_MAX_WHOLE} per request.`);
            if (!publicKey) throw new Error("Connect a wallet first.");
            return ix.faucet(program, publicKey, t.mint, a, t.decimals);
          },
        },
      }}
    />
  );
}

export function FaucetView() {
  const { isConnected, markets } = useApp();
  const bal = useBalances().data;
  const held = (mint: PublicKey) => (bal ? (bal.byMint[mint.toBase58()] ?? 0) : undefined);
  const stocks: Tok[] = markets.map((m) => ({
    symbol: m.symbol,
    mint: m.mint,
    decimals: STOCK_DECIMALS,
    per: m.kind === "Treasury fund" ? 100 : 10,
    note: m.kind === "Treasury fund" ? "Test T-Bill fund" : `Test ${m.name} stock`,
  }));
  const usdc: Tok = { symbol: LOAN_SYMBOL, mint: USDC_MINT, decimals: USDC_DECIMALS, per: 1000, note: "To repay or try liquidations" };
  const sol = bal?.sol;

  return (
    <>
      <PageHead title="Faucet" sub="Everything you need to try Finity on Solana devnet: a little SOL for fees, then test stock tokens and USDC." />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H>1. Devnet SOL for fees</H>
            <div className="cx-row">
              <GradientCard
                tag="SOL"
                big={!isConnected ? "Not connected" : sol === undefined ? "…" : `${num(sol, 3)} SOL`}
                label="Each transaction costs about 0.000005 SOL"
                value="Opening a token account or loan costs ~0.002 SOL rent"
                pill={sol !== undefined && sol >= 0.01 ? <Pill tone="good">Ready</Pill> : <Pill>Step 1</Pill>}
              />
            </div>
            <div style={{ marginTop: 18, display: "grid", gap: 14, justifyItems: "start" }}>
              {!isConnected ? (
                <ConnectFirst label="Connect wallet" />
              ) : (
                <Note icon="cash">
                  Get devnet SOL from{" "}
                  <a href="https://faucet.solana.com" target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                    faucet.solana.com
                  </a>{" "}
                  and make sure your wallet is set to devnet.
                </Note>
              )}
            </div>
          </section>
          <section>
            <H right={<small>Collateral you can borrow against</small>}>2. Test stocks and T-Bill fund</H>
            <div className="cx-row cx-row-even">
              {stocks.map((t) => (
                <DripTile key={t.symbol} t={t} held={held(t.mint)} />
              ))}
            </div>
          </section>
          <section>
            <H right={<small>The loan token</small>}>3. Test USDC</H>
            <div className="cx-row">
              <DripTile t={usdc} held={held(USDC_MINT)} />
            </div>
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Fees" value={sol === undefined ? "—" : num(sol, 4)} chip="SOL · devnet" />
          <KV
            rows={[
              ["Network", CLUSTER_NAME],
              ["Per request", `Up to ${num(FAUCET_MAX_WHOLE, 0)} tokens`],
              ["Value", "None: test tokens only"],
            ]}
          />
          <Note icon="alert">Phantom, Solflare and Backpack all work. Switch the wallet to devnet in its settings before connecting.</Note>
        </aside>
      </div>
    </>
  );
}
