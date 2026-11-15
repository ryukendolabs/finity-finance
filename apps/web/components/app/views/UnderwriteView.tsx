"use client";

import { BN, POOL_SHARE_DECIMALS, CLOSURE_NAMES } from "@finity/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { ActionTile, Row, plain, units, type Spec } from "../actions";
import { ActivityList, Bar, GradientCard, H, KV, Note, PageHead, Pill, StatBlock, num, pct, usd } from "../ui";
import { ConnectNote, ErrorNote, NoActivity, useActivityRows } from "./shared";
import { tokenLogo } from "@/lib/protocol";
import {
  LOAN_SYMBOL,
  POOL_LABEL,
  USDC_DECIMALS,
  USDC_MINT,
  poolIx,
  useBalances,
  usePool,
  usePoolTickets,
  useProgram,
  type Venue,
} from "@/lib/solana";
import { et, until } from "@/lib/time";

const signed = (r: number) => `${r < 0 ? "−" : "+"}${Math.abs(r * 100).toFixed(3)}%`;

function PoolSwitch({ venue }: { venue: Venue }) {
  const router = useRouter();
  return (
    <div className="cx-seg" role="group" aria-label="Pool">
      {(["XNYS", "USBANK"] as const).map((v) => (
        <button key={v} type="button" aria-pressed={v === venue} onClick={() => router.replace(v === "XNYS" ? "/app/underwrite" : "/app/underwrite?pool=USBANK")}>
          {POOL_LABEL[v]}
        </button>
      ))}
    </div>
  );
}

export function UnderwriteView({ venue }: { venue: Venue }) {
  const { publicKey, connected } = useWallet();
  const program = useProgram();
  const q = usePool(venue);
  const pool = q.data;
  const bal = useBalances().data;
  const tickets = usePoolTickets(venue).data ?? [];
  const activity = useActivityRows(publicKey?.toBase58(), `pool-${venue}`);
  const loan = LOAN_SYMBOL;
  const wallet = bal?.byMint[USDC_MINT.toBase58()] ?? 0;
  const sharesRaw = pool ? (bal?.rawByMint[pool.shareMint.toBase58()] ?? 0n) : 0n;
  const shares = Number(sharesRaw) / 10 ** POOL_SHARE_DECIMALS;
  const position = shares * (pool?.sharePrice ?? 0);
  const ep = pool?.epoch ?? null;
  const owner = () => {
    if (!publicKey) throw new Error("Connect a wallet first.");
    return publicKey;
  };

  const specs: Spec[] = [
    {
      icon: "deposit",
      title: "Deposit",
      sub: "Earn premiums & fees",
      amount: `${num(wallet, 0)} ${loan}`,
      dialog: {
        title: `Deposit into the ${POOL_LABEL[venue].toLowerCase()}`,
        description:
          "Your capital takes first loss at each reopen and earns every Gap Cover premium and the pool's 10% share of all borrow interest.",
        fields: [{ key: "a", unit: loan, quick: [{ label: "100", value: "100" }, { label: "500", value: "500" }, { label: "Wallet", value: plain(wallet, 2) }] }],
        preview: (x) => [
          ["Pool shares received", ep ? "At the epoch's settlement price" : num((x.a ?? 0) / (pool?.sharePrice || 1))],
          ["Counts from", ep ? `After epoch #${ep.seq} settles (deposits queue while an epoch is open)` : "Now, at today's share price"],
          ["Your new position", `${num(position + (x.a ?? 0))} ${loan}`],
        ],
        confirm: "Deposit",
        blocked: !pool ? "The pool is loading." : null,
        hint: "Test USDC comes from the Faucet page.",
        plan: async (x) => {
          const a = units(x.a, USDC_DECIMALS);
          return ep ? poolIx.depositQueued(program, owner(), venue, ep.seq, a) : poolIx.deposit(program, owner(), venue, a);
        },
        activity: (x) => ({ icon: "deposit", title: `Deposited ${loan} into the pool`, amount: `${num(Number(x.a))} ${loan}`, kind: `pool-${venue}` }),
      },
    },
    {
      icon: "withdraw",
      title: "Request exit",
      sub: "Paid after the epoch",
      amount: `${num(shares, 0)} sh`,
      dialog: {
        title: "Request a withdrawal",
        description:
          "Shares are escrowed for the next epoch to open: they stay at risk through that closure and are paid at its post-reopen share price.",
        fields: [{ key: "a", unit: "shares", quick: [{ label: "Half", value: plain(shares / 2, 4) }, { label: "All", value: plain(shares, 9) }] }],
        preview: (x) => [
          ["Shares to redeem", num(x.a ?? 0)],
          ["Value at today's price", `${num((x.a ?? 0) * (pool?.sharePrice ?? 0))} ${loan}`],
          ["Paid", `After epoch #${(pool?.epochsOpened ?? 0) + 1} settles`],
        ],
        confirm: "Request withdrawal",
        blocked: sharesRaw === 0n ? "You hold no pool shares." : null,
        plan: async (x) => {
          const want = BigInt(units(x.a, POOL_SHARE_DECIMALS, "a number of shares").toString());
          const s = want > sharesRaw || plain(shares, 9) === x.a ? sharesRaw : want;
          return poolIx.requestWithdraw(program, owner(), venue, (pool?.epochsOpened ?? 0) + 1, new BN(s.toString()));
        },
        activity: (x) => ({ icon: "clock", title: "Requested pool exit", amount: `${num(Number(x.a))} sh`, kind: `pool-${venue}` }),
      },
    },
  ];

  const history = pool?.history ?? [];
  const used = ep?.utilisation ?? 0;

  return (
    <>
      <PageHead
        title="Underwrite"
        sub="Hold first-loss capital through each market closure. Every closure is an epoch: you earn the premiums for exactly the risk you carried, and take any reopen loss before senior lenders."
        right={<PoolSwitch venue={venue} />}
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small>{venue === "XNYS" ? "Stock markets, NYSE calendar" : "T-Bill fund, US bank calendar"}</small>}>Underwriter Pool</H>
            <Row specs={specs}>
              <GradientCard
                logo={tokenLogo(loan)}
                tag="POOL"
                big={connected ? `${num(position)} ${loan}` : "—"}
                label="Share price"
                value={pool ? pool.sharePrice.toFixed(6) : "—"}
                pill={<Pill>{ep ? `Epoch #${ep.seq}` : "Between epochs"}</Pill>}
              />
            </Row>
            {!connected && (
              <div style={{ marginTop: 18 }}>
                <ConnectNote>Connect a wallet to deposit and see your shares.</ConnectNote>
              </div>
            )}
          </section>
          {tickets.length > 0 && (
            <section>
              <H>Your epoch requests</H>
              <div className="cx-row">
                {tickets.map((t) => (
                  <ActionTile
                    key={t.key.toBase58()}
                    spec={{
                      icon: t.settled ? "cash" : "clock",
                      title: `Epoch #${t.seq}`,
                      sub: t.settled ? "Ready to claim" : t.depositAssets > 0 ? "Deposit queued" : "Exit queued",
                      amount: t.depositAssets > 0 ? `${num(t.depositAssets)} ${loan}` : `${num(Number(t.withdrawShares) / 10 ** POOL_SHARE_DECIMALS)} sh`,
                      dialog: {
                        title: `Claim epoch #${t.seq}`,
                        description: "Queued deposits are minted, and queued exits are paid, at the epoch's settlement price after the reopen.",
                        preview: () => [
                          ["Status", t.settled ? "Settled" : "Waiting for the reopen and settlement"],
                          ...(t.depositAssets > 0 ? ([["Deposit", `${num(t.depositAssets)} ${loan}`]] as [string, string][]) : []),
                          ...(t.withdrawShares > 0n ? ([["Exit", `${num(Number(t.withdrawShares) / 10 ** POOL_SHARE_DECIMALS)} shares`]] as [string, string][]) : []),
                        ],
                        confirm: "Claim",
                        blocked: t.settled ? null : "This epoch hasn't settled yet. It settles a few minutes after the reopen.",
                        plan: async () => poolIx.claim(program, owner(), venue, t.seq),
                        activity: () => ({ icon: "cash", title: `Claimed epoch #${t.seq}`, amount: t.depositAssets > 0 ? `${num(t.depositAssets)} ${loan}` : "Exit", kind: `pool-${venue}` }),
                      },
                    }}
                  />
                ))}
              </div>
            </section>
          )}
          <section>
            <H>{ep ? `Epoch #${ep.seq}` : "Epoch"}</H>
            {q.error && !pool ? (
              <ErrorNote error={q.error} />
            ) : ep ? (
              <>
                <KV
                  rows={[
                    ["Phase", <Pill key="p" tone={ep.phase === "Open" ? "good" : "warn"}>{ep.phase}</Pill>],
                    ["Closure", `${CLOSURE_NAMES[ep.closureType] ?? "—"}, ${et(ep.closeAt)} → ${et(ep.reopenAt)}`],
                    ["Bell window", `${et(ep.bellWindowAt)}${until(ep.bellWindowAt) ? ` (in ${until(ep.bellWindowAt)})` : ""}`],
                    ["Bell deadline (J frozen)", et(ep.bellAt)],
                    ["Covers written", `${ep.policies} · ${usd(ep.premiums, 2)} premiums`],
                    ["Equity at risk J", ep.equityAtRisk > 0 ? usd(ep.equityAtRisk, 0) : `${usd(pool?.nav ?? 0, 0)} (until the snapshot)`],
                    ["Worst stress loss", usd(ep.worstLoss, 0)],
                  ]}
                />
                <div style={{ marginTop: 16 }}>
                  <div className="cx-page-sub" style={{ margin: "0 0 8px" }}>
                    Capacity used {pct(used, 2)} of the 50% limit (worst of 256 joint stress closures / J)
                  </div>
                  <Bar value={used / 0.5} />
                </div>
              </>
            ) : (
              <Note icon="clock">No epoch is open; the keeper opens the next one for the coming close.</Note>
            )}
          </section>
          {history.length > 0 && (
            <section>
              <H>Settled epochs</H>
              <KV
                rows={history.map((e) => [
                  `#${e.seq} · ${CLOSURE_NAMES[e.closureType] ?? ""}`,
                  `${usd(e.premiums, 2)} premiums · ${usd(e.lossesPaid, 2)} losses · NAV ${signed(e.navBefore ? e.navAfter / e.navBefore - 1 : 0)}`,
                ])}
              />
            </section>
          )}
          <section>
            <H>Recent activity</H>
            {activity.length ? <ActivityList items={activity} /> : <NoActivity />}
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Pool NAV" value={pool ? usd(pool.nav, 0) : "—"} chip={POOL_LABEL[venue]} />
          <KV
            rows={[
              ["Free cash", usd(pool?.freeCash ?? 0, 0)],
              ["Auction inventory (marked)", usd(pool?.inventoryMark ?? 0, 2)],
              ...(venue === "USBANK" ? ([["Redemptions pending (at cost)", usd(pool?.claimsCost ?? 0, 2)]] as [string, string][]) : []),
              ["Unearned premiums", usd(pool?.unearned ?? 0, 2)],
              ["Queued deposits", usd(pool?.depositsQueued ?? 0, 0)],
              ["Losses paid, all time", usd(pool?.lossesPaid ?? 0, 2)],
              ["Your shares", connected ? num(shares) : "—"],
            ]}
          />
          <Note icon="shield">
            The pool earns every Gap Cover premium and 10% of all borrow interest, and pays reopen shortfalls first, before the protocol
            reserve and senior lenders. What it buys at an auction's reserve counts in NAV at min(market value, cost) until it is
            resold (stocks, by a falling-price auction on the Auctions page) or redeemed with the fund (T-Bill, paid the next day).
          </Note>
        </aside>
      </div>
    </>
  );
}
