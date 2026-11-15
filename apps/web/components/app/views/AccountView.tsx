"use client";

import { POOL_SHARE_DECIMALS, SHARE_DECIMALS, sharesToAssets } from "@finity/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { GradientCard, H, KV, Note, PageHead, Pill, StatBlock, num, usd } from "../ui";
import { ConnectNote } from "./shared";
import { useApp } from "@/lib/app";
import { CLUSTER_NAME, explorerAddress, shortAddress } from "@/lib/protocol";
import { SHARE_MINT, USDC_MINT, useBalances, usePool, useSeniorVault } from "@/lib/solana";

export function AccountView() {
  const { publicKey, wallet, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const app = useApp();
  const bal = useBalances().data;
  const { vault } = useSeniorVault(app.markets);
  const stock = usePool("XNYS").data;
  const fund = usePool("USBANK").data;

  const raw = (mint: { toBase58(): string } | undefined) => (mint && bal ? (bal.rawByMint[mint.toBase58()] ?? 0n) : 0n);
  const vaultPos = vault ? Number(sharesToAssets(raw(SHARE_MINT), vault.totalAssetsRaw, vault.shareSupply)) / 1e6 : 0;
  const poolPos = (p: typeof stock) => (p ? (Number(raw(p.shareMint)) / 10 ** POOL_SHARE_DECIMALS) * p.sharePrice : 0);
  const collateral = app.loans.reduce((a, l) => a + l.value, 0);
  const debt = app.loans.reduce((a, l) => a + l.debt, 0);
  const net = collateral - debt + vaultPos + poolPos(stock) + poolPos(fund);
  const addr = publicKey?.toBase58();

  return (
    <>
      <PageHead title="Account" sub="Your wallet and everything it holds across Finity on Solana devnet." />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H>Wallet</H>
            {!addr ? (
              <ConnectNote>Connect a Solana wallet (Phantom, Solflare, Backpack) set to devnet.</ConnectNote>
            ) : (
              <div className="cx-row">
                <GradientCard
                  tag={CLUSTER_NAME}
                  big={shortAddress(addr)}
                  label="Wallet"
                  value={wallet?.adapter.name ?? "Connected"}
                  pill={<Pill tone="good">Connected</Pill>}
                />
              </div>
            )}
          </section>
          {addr && (
            <>
              <section>
                <H>Positions</H>
                <KV
                  rows={[
                    ["Collateral", usd(collateral, 2)],
                    ["Debt", usd(debt, 2)],
                    ["Senior Vault", `${num(vaultPos)} USDC · ${num(Number(raw(SHARE_MINT)) / 10 ** SHARE_DECIMALS)} shares`],
                    ["Underwriter Pools", `${num(poolPos(stock))} USDC stock pool · ${num(poolPos(fund))} USDC T-Bill pool`],
                  ]}
                />
              </section>
              <section>
                <H>Wallet balances</H>
                <KV
                  rows={[
                    ["SOL (fees)", num(bal?.sol ?? 0, 4)],
                    ["USDC (test)", num(bal?.byMint[USDC_MINT.toBase58()] ?? 0)],
                    ...app.markets
                      .filter((m) => (bal?.byMint[m.mint.toBase58()] ?? 0) > 0)
                      .map((m) => [`${m.symbol} (test)`, num(bal!.byMint[m.mint.toBase58()]!, 4)] as [string, string]),
                  ]}
                />
              </section>
              <Note icon="external">
                Every account is public on-chain.{" "}
                <a href={explorerAddress(addr)} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                  See this wallet on the explorer
                </a>
                .
              </Note>
            </>
          )}
        </div>
        <aside className="cx-aside">
          <StatBlock label="Net position" value={usd(net, 0)} chip="All roles" />
          <button
            type="button"
            className="cx-btn"
            onClick={() => (addr ? void disconnect() : setVisible(true))}
          >
            {addr ? "Disconnect wallet" : "Connect wallet"}
          </button>
          <KV rows={[["Network", CLUSTER_NAME], ["Loans", String(app.loans.length)]]} />
        </aside>
      </div>
    </>
  );
}
