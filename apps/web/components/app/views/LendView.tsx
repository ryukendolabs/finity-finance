"use client";

import { LEND_DECIMALS, ataOf } from "@finity/solana/lend";
import { createTransferInstruction } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { Row, plain, units, type Spec } from "../actions";
import { ActivityList, Bar, GradientCard, H, KV, Note, PageHead, Pill, StatBlock, num, pct, usd } from "../ui";
import { ConnectNote, ErrorNote, Loading, NoActivity, useActivityRows } from "./shared";
import { LEND_ADDR, LEND_LOAN, useIsLender, useLendMarkets, useLendWallet } from "@/lib/lend";

export function LendView() {
  const { publicKey, connected } = useWallet();
  const lend = useLendMarkets();
  const pool = lend.data?.pool;
  const markets = lend.data?.markets ?? [];
  const isLender = useIsLender().data === true;
  const wallet = useLendWallet().data;
  const usdHeld = wallet?.ui(LEND_LOAN) ?? 0;
  const activity = useActivityRows(publicKey?.toBase58(), "lend");
  const owner = () => {
    if (!publicKey) throw new Error("Connect a wallet first.");
    return publicKey;
  };

  const specs: Spec[] = [
    {
      icon: "deposit",
      title: "Supply",
      sub: "Add to the pool",
      amount: `${num(usdHeld, 0)} ${LEND_LOAN} in wallet`,
      dialog: {
        title: `Supply ${LEND_LOAN}`,
        description: `Moves ${LEND_LOAN} from your wallet into the pool, where borrowers can draw on it right away. It comes back to your wallet when the pool closes.`,
        fields: [{ key: "a", unit: LEND_LOAN, quick: [{ label: "Half", value: plain(usdHeld / 2, 2) }, { label: "Wallet", value: plain(usdHeld, 2) }] }],
        preview: (x) => [
          ["Wallet balance", `${num(usdHeld)} ${LEND_LOAN}`],
          ["Pool after", `${num((pool?.supplied ?? 0) + (x.a ?? 0), 0)} ${LEND_LOAN}`],
        ],
        confirm: "Supply",
        blocked: usdHeld <= 0 ? `Your wallet holds no ${LEND_LOAN}.` : null,
        lend: true,
        plan: async (x) => {
          if (Number(x.a) > usdHeld) throw new Error(`You hold ${num(usdHeld)} ${LEND_LOAN}.`);
          const a = LEND_ADDR!;
          const amount = BigInt(units(x.a, LEND_DECIMALS).toString());
          return [createTransferInstruction(ataOf(owner(), a.usdMint), a.loanVault, owner(), amount)];
        },
        activity: (x) => ({ icon: "deposit", title: `Supplied ${LEND_LOAN}`, amount: `${num(Number(x.a))} ${LEND_LOAN}`, kind: "lend" }),
      },
    },
  ];

  return (
    <>
      <PageHead
        title="Lend"
        sub="The USDC pool behind every market on Solana mainnet. Borrowers draw from it against their xStocks and pay it back into it."
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small>{pool ? `${pool.loans} open loan${pool.loans === 1 ? "" : "s"}` : ""}</small>}>Lending pool</H>
            {lend.error && !pool ? (
              <ErrorNote error={lend.error} />
            ) : lend.isLoading ? (
              <Loading what="Loading the pool" />
            ) : !pool ? (
              <Note icon="clock">The pool opens soon.</Note>
            ) : isLender ? (
              <Row specs={specs}>
                <GradientCard
                  tag={LEND_LOAN}
                  big={`${num(pool.supplied, 0)} ${LEND_LOAN}`}
                  label="Your supply"
                  value={`${num(pool.lent, 0)} ${LEND_LOAN} lent out`}
                  pill={<Pill tone="good">Lender</Pill>}
                />
              </Row>
            ) : (
              <div className="cx-row">
                <GradientCard
                  tag={LEND_LOAN}
                  big={`${num(pool.supplied, 0)} ${LEND_LOAN}`}
                  label="Pool size"
                  value={`${num(pool.cash, 0)} ${LEND_LOAN} ready to borrow`}
                  pill={<Pill>Pool</Pill>}
                />
              </div>
            )}
            {!connected && pool && (
              <div style={{ marginTop: 18 }}>
                <ConnectNote>Connect a wallet to see your lending.</ConnectNote>
              </div>
            )}
          </section>
          {pool && (
            <section>
              <H>Pool</H>
              <KV
                rows={[
                  ["Total supplied", `${num(pool.supplied, 0)} ${LEND_LOAN}`],
                  ["Lent to borrowers", `${num(pool.lent, 0)} ${LEND_LOAN}`],
                  ["Ready to borrow", `${num(pool.cash, 0)} ${LEND_LOAN}`],
                  ["Collateral behind loans", usd(pool.collateralValue, 0)],
                  ["Interest", "None"],
                ]}
              />
              <div style={{ marginTop: 16 }}>
                <div className="cx-page-sub" style={{ margin: "0 0 8px" }}>
                  Utilisation {pct(pool.utilisation, 1)}
                </div>
                <Bar value={pool.utilisation} />
              </div>
            </section>
          )}
          {isLender && (
            <section>
              <H>Recent activity</H>
              {activity.length ? <ActivityList items={activity} /> : <NoActivity />}
            </section>
          )}
        </div>
        <aside className="cx-aside">
          <StatBlock label="Lent out" value={pool ? usd(pool.lent, 0) : "—"} chip={pool ? `${pct(pool.utilisation, 1)} of the pool` : "—"} />
          <div>
            <H>Collateral by market</H>
            <KV rows={markets.map((m) => [m.symbol, `${num(m.collateral, 2)} · ${usd(m.collateralValue, 0)}`])} />
          </div>
          <Note icon="vault">
            The pool is one token account held by the contract. Loans are paid out of it and repayments go straight back in; collateral sits in
            a separate vault per market until its loan is paid off.
          </Note>
        </aside>
      </div>
    </>
  );
}
