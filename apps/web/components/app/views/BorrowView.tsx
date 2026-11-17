"use client";

import { LEND_DECIMALS, POSITION_LEN, createProgramAccountIx, lendIx } from "@finity/solana/lend";
import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { useState, type ReactNode } from "react";
import { Row, plain, units, type Spec } from "../actions";
import { GradientCard, H, KV, Note, PageHead, Pill, StatBlock, num, pct, usd } from "../ui";
import { ConnectNote, ErrorNote, Loading, NoLoans } from "./shared";
import {
  LEND_ADDR,
  LEND_LOAN,
  lendConn,
  useLendLoans,
  useLendMarkets,
  useLendWallet,
  type LendLoan,
  type LendMarketView,
} from "@/lib/lend";
import { ticker, tokenLogo } from "@/lib/protocol";

/** An input in base units: the loan token's decimals by default, or a market's collateral decimals. */
const raw = (v: string | undefined, what?: string, decimals = LEND_DECIMALS) => BigInt(units(v, decimals, what).toString());
const PAUSED = "Borrowing waits for the next price: prices are posted while US markets are open. Repaying always works.";

function after(m: LendMarketView, debt: number, tokens: number): [string, ReactNode][] {
  const value = tokens * m.price;
  return [
    ["New debt", `${num(Math.max(0, debt))} ${LEND_LOAN}`],
    ["New LTV", value > 0 ? pct(debt / value, 2) : "—"],
    ["Limit", `${pct(m.maxLtv, 0)} LTV`],
  ];
}

/** The ensure-token-account instructions a position op needs: the wallet's collateral and loan accounts. */
function accounts(owner: PublicKey, m: LendMarketView) {
  const a = LEND_ADDR!;
  return [lendIx.ensureAta(owner, owner, m.mint, m.tokenProgram), lendIx.ensureAta(owner, owner, a.usdMint)];
}
const NONE = (sym: string) => `Your wallet holds no ${sym}. Buy some first, for example on Jupiter.`;

function LoanSection({ l, held, usdHeld, cash }: { l: LendLoan; held: number; usdHeld: number; cash: number }) {
  const { publicKey } = useWallet();
  const m = l.market;
  const sym = ticker(m.symbol);
  const owner = () => {
    if (!publicKey) throw new Error("Connect a wallet first.");
    return publicKey;
  };
  const a = LEND_ADDR!;
  const specs: Spec[] = [];
  if (l.debt > 0 || l.collateral > 0) {
    specs.push({
      icon: "cash",
      title: "Borrow",
      sub: m.paused ? "Waiting for a price" : "Up to your limit",
      amount: `${num(l.canBorrow, 0)} ${LEND_LOAN}`,
      dialog: {
        title: `Borrow ${LEND_LOAN} against ${sym}`,
        description: `Up to ${pct(m.maxLtv, 0)} of your collateral's value. Price ${usd(m.price)} per ${sym}. No interest.`,
        fields: [{ key: "a", unit: LEND_LOAN, quick: [{ label: "Half", value: plain(l.canBorrow / 2, 2) }, { label: "Max", value: plain(l.canBorrow, 2) }] }],
        preview: (v) => [...after(m, l.debt + (v.a ?? 0), l.collateral), ["Left in the pool", `${num(cash, 0)} ${LEND_LOAN}`]],
        confirm: "Borrow",
        blocked: m.paused ? PAUSED : l.collateral <= 0 ? `Add ${sym} as collateral first.` : l.canBorrow <= 0 ? "This loan is at its limit." : null,
        lend: true,
        plan: async (v) => {
          if (Number(v.a) > l.canBorrow + 1e-6) throw new Error(`That's above your limit of ${num(l.canBorrow)} ${LEND_LOAN}.`);
          if (Number(v.a) > cash) throw new Error(`The pool has ${num(cash)} ${LEND_LOAN} left to lend.`);
          return [...accounts(owner(), m), lendIx.borrow(a, l.key, owner(), m.index, 0n, raw(v.a), false)];
        },
        activity: (v) => ({ icon: "cash", title: `Borrowed against ${sym}`, amount: `${num(Number(v.a))} ${LEND_LOAN}`, kind: "borrow" }),
      },
    });
    specs.push({
      icon: "plus",
      title: "Add collateral",
      sub: `Deposit ${sym}`,
      amount: `${num(l.collateral, 4)} ${sym} in`,
      dialog: {
        title: `Add ${sym}`,
        description: "Adding collateral works at any time and raises how much you can borrow.",
        fields: [{ key: "a", unit: sym, quick: held > 0 ? [{ label: "All", value: plain(held, 6) }] : [] }],
        preview: (v) => [...after(m, l.debt, l.collateral + (v.a ?? 0)), ["Wallet", `${num(held, 4)} ${sym}`]],
        confirm: "Add collateral",
        blocked: held <= 0 ? NONE(sym) : null,
        lend: true,
        plan: async (v) => [...accounts(owner(), m), lendIx.borrow(a, l.key, owner(), m.index, raw(v.a, undefined, m.decimals), 0n, false)],
        activity: (v) => ({ icon: "deposit", title: `Deposited ${sym}`, amount: `${num(Number(v.a), 4)} ${sym}`, kind: "borrow" }),
      },
    });
  }
  if (l.debt > 0) {
    specs.push({
      icon: "repay",
      title: "Repay",
      sub: "Pay it all to get your collateral back",
      amount: `${num(l.debt)} ${LEND_LOAN}`,
      dialog: {
        title: `Repay ${sym} loan`,
        description: "Repaying works at any time. Paying the whole loan returns all your collateral in the same transaction.",
        fields: [{ key: "a", unit: LEND_LOAN, initial: plain(l.debt, 6), quick: [{ label: "Half", value: plain(l.debt / 2, 6) }, { label: "All", value: plain(l.debt, 6) }] }],
        preview: (v) => [
          ...after(m, l.debt - (v.a ?? 0), (v.a ?? 0) >= l.debt ? 0 : l.collateral),
          ["Collateral back", (v.a ?? 0) >= l.debt ? `${num(l.collateral, 4)} ${sym}` : "When the loan is paid off"],
          ["Wallet", `${num(usdHeld)} ${LEND_LOAN}`],
        ],
        confirm: "Repay",
        lend: true,
        plan: async (v) => {
          const amount = raw(v.a);
          if (amount > l.debtRaw) throw new Error(`Your debt is ${num(l.debt, 6)} ${LEND_LOAN}.`);
          if (Number(v.a) > usdHeld + 1e-9) throw new Error(`You hold ${num(usdHeld)} ${LEND_LOAN}.`);
          return [...accounts(owner(), m), lendIx.repay(a, l.key, owner(), m.index, amount)];
        },
        activity: (v) => ({ icon: "repay", title: `Repaid ${sym} loan`, amount: `${num(Number(v.a))} ${LEND_LOAN}`, kind: "borrow" }),
      },
    });
  } else if (l.collateral > 0) {
    specs.push({
      icon: "withdraw",
      title: "Withdraw",
      sub: "No debt: take it all back",
      amount: `${num(l.collateral, 4)} ${sym}`,
      dialog: {
        title: `Withdraw ${sym}`,
        description: "This loan has no debt, so all of its collateral can come back to your wallet.",
        preview: () => [["You receive", `${num(l.collateral, 4)} ${sym}`]],
        confirm: "Withdraw",
        lend: true,
        plan: async () => [...accounts(owner(), m), lendIx.repay(a, l.key, owner(), m.index, 0n)],
        activity: () => ({ icon: "withdraw", title: `Withdrew ${sym}`, amount: `${num(l.collateral, 4)} ${sym}`, kind: "borrow" }),
      },
    });
  } else {
    specs.push({
      icon: "close",
      title: "Close",
      sub: "Get the deposit back",
      amount: "~0.0015 SOL",
      dialog: {
        title: `Close the ${sym} loan`,
        description: "This loan is empty. Closing it returns the account deposit to your wallet.",
        preview: () => [["You receive", "The loan account's SOL deposit"]],
        confirm: "Close",
        lend: true,
        plan: async () => [lendIx.close(l.key, owner())],
        activity: () => ({ icon: "close", title: `Closed ${sym} loan`, amount: "Deposit back", kind: "borrow" }),
      },
    });
  }
  return (
    <section>
      <H right={<small>{num(l.collateral, 4)} {sym} · {usd(l.value, 0)} collateral</small>}>{m.name} loan</H>
      <Row specs={specs}>
        <GradientCard
          logo={tokenLogo(m.base)}
          tag={sym}
          big={`${num(l.debt)} ${LEND_LOAN}`}
          label="Loan to value"
          value={l.debt > 0 ? `${pct(l.ltv, 1)} of ${pct(m.maxLtv, 0)} max` : "No debt"}
          pill={l.debt <= 0 ? <Pill tone="soft">No debt</Pill> : l.ltv > m.maxLtv ? <Pill tone="warn">Above limit</Pill> : <Pill tone="good">Within limit</Pill>}
        />
      </Row>
      {l.debt > 0 && l.ltv > m.maxLtv && (
        <div style={{ marginTop: 16 }}>
          <Note icon="alert">
            The {sym} price has moved, so this loan is above its {pct(m.maxLtv, 0)} limit. You can&apos;t borrow more against it until you repay
            some or add collateral.
          </Note>
        </div>
      )}
    </section>
  );
}

function OpenLoan({ m, held, cash }: { m: LendMarketView; held: number; cash: number }) {
  const { publicKey } = useWallet();
  const sym = ticker(m.symbol);
  const spec: Spec = {
    icon: "cash",
    title: "Open a loan",
    sub: m.paused ? "Deposit now, borrow later" : `Up to ${pct(m.maxLtv, 0)} LTV`,
    amount: `${num(held, 4)} ${sym} held`,
    dialog: {
      title: `Borrow against ${sym}`,
      description: `Deposit ${sym} and borrow up to ${pct(m.maxLtv, 0)} of its value in one transaction. Opening a loan takes a ~0.0015 SOL account deposit, returned when you close it.`,
      fields: [
        { key: "c", label: "Collateral", unit: sym, quick: held > 0 ? [{ label: "All", value: plain(held, 6) }] : [] },
        { key: "a", label: "Borrow", unit: LEND_LOAN, initial: "0" },
      ],
      preview: (v) => {
        const value = (v.c ?? 0) * m.price;
        return [
          ["Collateral value", m.paused ? "Waiting for a price" : usd(value)],
          ["Borrow up to", m.paused ? "—" : `${num(value * m.maxLtv)} ${LEND_LOAN}`],
          ["LTV", value > 0 ? pct((v.a ?? 0) / value, 2) : "—"],
        ];
      },
      confirm: "Open loan",
      blocked: held <= 0 ? NONE(sym) : null,
      lend: true,
      plan: async (v) => {
        if (!publicKey) throw new Error("Connect a wallet first.");
        const coll = raw(v.c, "the collateral", m.decimals);
        const loan = Number(v.a) > 0 ? raw(v.a) : 0n;
        if (loan > 0n && m.paused) throw new Error(PAUSED);
        if (Number(v.c) > held) throw new Error(`You hold ${num(held, 4)} ${sym}.`);
        if (Number(v.a) > Number(v.c) * m.price * m.maxLtv) throw new Error(`That's above the ${pct(m.maxLtv, 0)} limit.`);
        if (Number(v.a) > cash) throw new Error(`The pool has ${num(cash)} ${LEND_LOAN} left to lend.`);
        const position = Keypair.generate();
        return {
          ixs: [
            ...accounts(publicKey, m),
            await createProgramAccountIx(lendConn(), publicKey, position.publicKey, POSITION_LEN),
            lendIx.borrow(LEND_ADDR!, position.publicKey, publicKey, m.index, coll, loan, true),
          ],
          signers: [position],
        };
      },
      activity: (v) => ({ icon: "cash", title: `Opened ${sym} loan`, amount: `${num(Number(v.a) || 0)} ${LEND_LOAN}`, kind: "borrow" }),
    },
  };
  return (
    <Row specs={[spec]}>
      <GradientCard
        logo={tokenLogo(m.base)}
        tag={sym}
        big={m.paused ? "Price paused" : usd(m.price)}
        label={`Borrow up to ${pct(m.maxLtv, 0)} LTV`}
        value={`You hold ${num(held, 4)} ${sym}`}
        pill={<Pill tone={m.paused ? "soft" : "good"}>{m.paused ? "Paused" : "Borrowing"}</Pill>}
      />
    </Row>
  );
}

export function BorrowView({ m: initial = "" }: { m?: string }) {
  const { connected } = useWallet();
  const lend = useLendMarkets();
  const markets = lend.data?.markets;
  const cash = lend.data?.pool.cash ?? 0;
  const { loans, isLoading } = useLendLoans(markets);
  const wallet = useLendWallet().data;
  const held = (s: string) => wallet?.ui(s) ?? 0;
  const debt = loans.reduce((s, l) => s + l.debt, 0);
  const open = new Set(loans.map((l) => l.market.symbol));
  const choices = (markets ?? []).filter((m) => !open.has(m.symbol));
  const [pick, setPick] = useState<string | null>(initial || null);
  const chosen = choices.find((m) => m.symbol === pick) ?? choices[0];

  return (
    <>
      <PageHead title="Borrow" sub="Borrow USDC against tokenized stocks (xStocks) on Solana mainnet. No interest; repay any time to get your collateral back." />
      <div className="cx-grid">
        <div className="cx-col">
          {lend.error && !markets ? (
            <ErrorNote error={lend.error} />
          ) : !connected ? (
            <section>
              <H>Your loans</H>
              <ConnectNote>Connect a Solana wallet to open a loan or manage the ones you have.</ConnectNote>
            </section>
          ) : lend.isLoading || isLoading ? (
            <Loading what="Loading your loans" />
          ) : !markets ? (
            <Note icon="clock">Borrowing opens soon.</Note>
          ) : loans.length === 0 ? (
            <section>
              <H>Your loans</H>
              <NoLoans />
            </section>
          ) : (
            loans.map((l) => <LoanSection key={l.key.toBase58()} l={l} held={held(l.market.symbol)} usdHeld={held(LEND_LOAN)} cash={cash} />)
          )}
          {connected && chosen && (
            <section>
              <H right={<small>Deposit collateral and borrow</small>}>Open a loan</H>
              <div className="cx-seg" role="group" aria-label="Market" style={{ marginBottom: 18 }}>
                {choices.map((m) => (
                  <button key={m.symbol} type="button" aria-pressed={m.symbol === chosen.symbol} onClick={() => setPick(m.symbol)}>
                    {ticker(m.symbol)}
                  </button>
                ))}
              </div>
              <OpenLoan key={chosen.symbol} m={chosen} held={held(chosen.symbol)} cash={cash} />
            </section>
          )}
        </div>
        <aside className="cx-aside">
          <StatBlock label="Total debt" value={usd(debt, 0)} chip={`${loans.filter((l) => l.debt > 0).length} loans`} />
          {loans.length > 0 && (
            <div>
              <H>Loan to value</H>
              <KV rows={loans.map((l) => [ticker(l.market.symbol), l.debt > 0 ? `${pct(l.ltv, 1)} of ${pct(l.market.maxLtv, 0)}` : "No debt"])} />
            </div>
          )}
          <div>
            <H>How it works</H>
            <KV
              rows={[
                ["Loan token", LEND_LOAN],
                ["Collateral", "xStocks (AAPLx, NVDAx, …)"],
                ["Interest", "None"],
                ["Limit", "Max LTV, checked when you borrow"],
                ["Collateral back", "When the loan is paid off"],
              ]}
            />
          </div>
          <Note icon="alert">
            Your wallet pays the network fee (about 0.00002 SOL) and a small refundable deposit for each new account: ~0.002 SOL per token
            account, ~0.0015 SOL per loan.
          </Note>
        </aside>
      </div>
    </>
  );
}
