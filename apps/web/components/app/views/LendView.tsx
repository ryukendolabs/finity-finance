"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { ActionTile, Row, plain, units, type Spec } from "../actions";
import { ActivityList, Bar, GradientCard, H, KV, Note, PageHead, Pill, StatBlock, Waterfall, num, pct, usd } from "../ui";
import { ConnectNote, ErrorNote, NoActivity, useActivityRows } from "./shared";
import { useApp } from "@/lib/app";
import { usePool, useReserve } from "@/lib/solana";
import { tokenLogo } from "@/lib/protocol";
import {
  LOAN_SYMBOL,
  SHARE_DECIMALS,
  SHARE_MINT,
  USDC_DECIMALS,
  USDC_MINT,
  ix,
  useBalances,
  useProgram,
  useRedeemTickets,
  useSeniorVault,
} from "@/lib/solana";
import { BN, assetsToShares, sharesToAssets } from "@finity/solana";

export function LendView() {
  const { publicKey } = useWallet();
  const app = useApp();
  const program = useProgram();
  const { vault, error } = useSeniorVault(app.markets);
  const bal = useBalances().data;
  const tickets = useRedeemTickets().data ?? [];
  const activity = useActivityRows(publicKey?.toBase58(), "lend");
  const loan = LOAN_SYMBOL;
  const isConnected = app.isConnected;

  const shares = bal?.rawByMint[SHARE_MINT.toBase58()] ?? 0n;
  const wallet = bal?.byMint[USDC_MINT.toBase58()] ?? 0;
  const position = vault ? Number(sharesToAssets(shares, vault.totalAssetsRaw, vault.shareSupply)) / 1e6 : 0;
  const maxWithdraw = Math.min(position, vault?.available ?? 0);
  const poolNav = (usePool("XNYS").data?.nav ?? 0) + (usePool("USBANK").data?.nav ?? 0);
  const reserveCash = useReserve().data?.cash ?? 0;
  const cushion = poolNav + reserveCash + (vault?.poolFees ?? 0) + (vault?.treasuryFees ?? 0);
  const apy = vault?.apy ?? 0;
  const owner = () => {
    if (!publicKey) throw new Error("Connect a wallet first.");
    return publicKey;
  };

  const specs: Spec[] = [
    {
      icon: "deposit",
      title: "Deposit",
      sub: "Earn senior interest",
      amount: `${pct(apy, 2)} APY`,
      dialog: {
        title: `Deposit ${loan}`,
        description: "Deposits earn the senior share of borrow interest and are never locked by the market clock.",
        fields: [
          {
            key: "a",
            unit: loan,
            quick: [
              { label: "100", value: "100" },
              { label: "500", value: "500" },
              { label: "Wallet", value: plain(wallet, 2) },
            ],
          },
        ],
        preview: (x) => [
          ["Wallet balance", `${num(wallet)} ${loan}`],
          ["Your new position", `${num(position + (x.a ?? 0))} ${loan}`],
          ["Est. yearly interest", `${num((position + (x.a ?? 0)) * apy)} ${loan}`],
          ["Protected by", `${num(cushion, 2)} ${loan} of first-loss capital`],
        ],
        confirm: "Deposit",
        blocked: !vault ? "The vault is still loading." : null,
        hint: "Test USDC comes from the Faucet page.",
        plan: async (x) => ix.lendDeposit(program, owner(), vault!.marketKeys, units(x.a, USDC_DECIMALS)),
        activity: (x) => ({ icon: "deposit", title: `Deposited ${loan}`, amount: `${num(Number(x.a))} ${loan}`, kind: "lend" }),
      },
    },
    {
      icon: "withdraw",
      title: "Withdraw",
      sub: "Any time liquidity allows",
      amount: `${num(position, 0)} ${loan}`,
      dialog: {
        title: `Withdraw ${loan}`,
        description: "Withdraw up to the vault's available liquidity now; anything larger is queued and paid as borrowers repay.",
        fields: [
          {
            key: "a",
            unit: loan,
            quick: [
              { label: "Half", value: plain(position / 2, 2) },
              { label: "Max", value: plain(position, 6) },
            ],
          },
        ],
        preview: (x) => [
          ["Remaining position", `${num(Math.max(0, position - (x.a ?? 0)))} ${loan}`],
          ["Withdrawable now", `${num(maxWithdraw)} ${loan}`],
          ["Paid", (x.a ?? 0) <= maxWithdraw ? "Now, from available liquidity" : "Queued, paid as borrowers repay"],
        ],
        confirm: "Withdraw",
        blocked: shares === 0n ? "You have no deposit in this vault." : null,
        plan: async (x) => {
          const a = BigInt(units(x.a, USDC_DECIMALS).toString());
          // All of it when the amount reaches the position (Max), otherwise the matching shares, rounded up.
          const all = Number(x.a) >= position - 0.000001;
          const want = all ? shares : assetsToShares(a, vault!.totalAssetsRaw, vault!.shareSupply) + 1n;
          const s = want > shares ? shares : want;
          if (Number(x.a) <= maxWithdraw) return ix.lendRedeem(program, owner(), vault!.marketKeys, new BN(s.toString()));
          // Larger than the liquidity available now: queue a redemption for those shares.
          return ix.requestRedeem(program, owner(), new BN(s.toString()));
        },
        activity: (x) =>
          Number(x.a) <= maxWithdraw
            ? { icon: "withdraw", title: `Withdrew ${loan}`, amount: `${num(Number(x.a))} ${loan}`, kind: "lend" }
            : { icon: "clock", title: `Queued ${loan} withdrawal`, amount: `${num(Number(x.a))} ${loan}`, kind: "lend" },
      },
    },
  ];

  return (
    <>
      <PageHead
        title="Lend"
        sub="Deposit into the Senior Vault and earn the senior share of borrow interest. You sit behind the Underwriter Pool and the protocol reserve, and the market clock never locks your deposit."
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small>Solana devnet</small>}>Senior Vault</H>
            <Row specs={specs}>
              <GradientCard
                logo={tokenLogo(loan)}
                tag={loan}
                big={isConnected ? `${num(position)} ${loan}` : "—"}
                label="Share price"
                value={vault ? vault.sharePrice.toFixed(6) : "—"}
                pill={<Pill>Never locked</Pill>}
              />
            </Row>
            {!isConnected && (
              <div style={{ marginTop: 18 }}>
                <ConnectNote>Connect a wallet to deposit and see your position.</ConnectNote>
              </div>
            )}
          </section>
          {tickets.length > 0 && (
            <section>
              <H>Queued withdrawals</H>
              <div className="cx-row">
                {tickets.map((t) => (
                  <ActionTile
                    key={t.id}
                    spec={{
                      icon: t.processed ? "cash" : "clock",
                      title: `Request #${t.id}`,
                      sub: t.processed ? "Ready to claim" : "In the queue",
                      amount: t.processed ? `${num(t.assets)} ${loan}` : `${num(Number(t.shares) / 10 ** SHARE_DECIMALS)} sh`,
                      dialog: {
                        title: `Claim request #${t.id}`,
                        description: "Queued withdrawals are paid in order as borrowers repay; once processed, claim the funds here.",
                        preview: () => [
                          ["Status", t.processed ? "Processed" : "Waiting for liquidity"],
                          ["Amount", t.processed ? `${num(t.assets)} ${loan}` : "Set when processed"],
                        ],
                        confirm: "Claim",
                        blocked: t.processed ? null : "This withdrawal is still in the queue. It is paid as borrowers repay.",
                        plan: async () => ix.claimRedeem(program, owner(), t.id),
                        activity: () => ({ icon: "cash", title: `Claimed ${loan} withdrawal`, amount: `${num(t.assets)} ${loan}`, kind: "lend" }),
                      },
                    }}
                  />
                ))}
              </div>
            </section>
          )}
          <section>
            <H>Vault</H>
            {error && !vault ? (
              <ErrorNote error={error} />
            ) : (
              <>
                <KV
                  rows={[
                    ["Total deposits", `${num(vault?.tvl ?? 0, 0)} ${loan}`],
                    ["Lent to borrowers", `${num(vault?.borrowed ?? 0, 0)} ${loan}`],
                    ["Withdrawable now", `${num(vault?.available ?? 0, 0)} ${loan}`],
                    ["Senior APY", pct(apy, 2)],
                    ["Your shares", isConnected ? num(Number(shares) / 10 ** SHARE_DECIMALS) : "—"],
                    ["Withdrawal queue", vault ? `${vault.queueLength} waiting` : "—"],
                  ]}
                />
                <div style={{ marginTop: 16 }}>
                  <div className="cx-page-sub" style={{ margin: "0 0 8px" }}>
                    Utilisation {vault?.tvl ? pct(vault.borrowed / vault.tvl, 1) : "0%"}
                  </div>
                  <Bar value={vault?.tvl ? vault.borrowed / vault.tvl : 0} />
                </div>
              </>
            )}
          </section>
          <section>
            <H>Recent activity</H>
            {activity.length ? <ActivityList items={activity} /> : <NoActivity />}
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock
            label="Your cushion"
            value={`${num(cushion, 2)} ${loan}`}
            chip={vault?.borrowed ? `${pct(cushion / vault.borrowed, 2)} of loans` : "No loans yet"}
          />
          <p className="cx-page-sub" style={{ margin: "-18px 0 0" }}>
            First-loss capital that absorbs any reopen shortfall before senior lenders lose anything.
          </p>
          <div>
            <H>Who pays first</H>
            <Waterfall
              layers={[
                { name: "Underwriter Pool", note: "Paid premiums to take first loss", amount: usd(poolNav, 0), tone: "ink" },
                { name: "Protocol reserve", note: "Funded from the treasury's share of interest", amount: usd(reserveCash, 2), tone: "tile" },
                { name: "Senior Vault", note: "You, only after both are used up", amount: usd(vault?.tvl ?? 0, 0), tone: "white" },
              ]}
            />
          </div>
          <Note icon="vault">
            One vault lends to every market, up to a cap per market. Interest is split 80% to lenders, 10% to the Underwriter Pools
            and 10% to the protocol reserve; a reopen loss is paid by the pool, then the reserve, before it reaches this vault.
          </Note>
        </aside>
      </div>
    </>
  );
}
