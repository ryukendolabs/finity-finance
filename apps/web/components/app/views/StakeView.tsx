"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useMemo, useState } from "react";
import { ConnectFirst } from "../actions";
import { H, Note, Pill } from "../ui";

/**
 * Stake: lock $FINO for a fixed term and receive the principal plus a fixed reward at unlock. A design preview:
 * staking opens with the $FINO token, so nothing here reads or sends anything on-chain.
 */
const TERMS = [
  { days: 7, rate: 0.02 },
  { days: 30, rate: 0.1 },
  { days: 90, rate: 0.35 },
  { days: 180, rate: 0.8 },
  { days: 365, rate: 1.75 },
] as const;

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (r: number) => `${fmt(r * 100, r * 100 % 1 ? 1 : 0)}%`;
const unlockDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function StakeView() {
  const { connected } = useWallet();
  const [amount, setAmount] = useState("1000");
  const [pick, setPick] = useState(1);
  const value = Number(amount) || 0;
  const term = TERMS[pick]!;
  const reward = value * term.rate;
  const unlock = useMemo(() => unlockDate(term.days), [term.days]);

  return (
    <div className="cx-stake">
      <header className="cx-stake-hero">
        <div className="cx-stake-eyebrow">
          <span>$FINO staking</span>
          <Pill>Preview</Pill>
        </div>
        <h1 className="cx-page-title">
          Lock $FINO. <em>Pick a term.</em>
        </h1>
        <p className="cx-page-sub">
          {TERMS.map((t) => `${t.days} days +${pct(t.rate)}`).join(", ")}. Send $FINO from your wallet and receive the principal plus
          the reward automatically at unlock. A locked stake also lowers the fee on every Finity loan.
        </p>
      </header>

      <section className="cx-stake-panel cx-stake-total">
        <div>
          <div className="cx-stake-label">Total staked</div>
          <div className="cx-stake-big">0</div>
          <div className="cx-stake-muted">
            $FINO locked by everyone <span className="cx-stake-mono">$0.00</span>
          </div>
        </div>
        <span className="cx-stake-muted">Staking vault · at launch</span>
      </section>

      <div className="cx-stake-terms" role="radiogroup" aria-label="Lock term">
        {TERMS.map((t, i) => (
          <button
            key={t.days}
            type="button"
            role="radio"
            aria-checked={i === pick}
            className={`cx-stake-term${i === pick ? " is-on" : ""}`}
            onClick={() => setPick(i)}
          >
            <span className="cx-stake-label">{t.days} days</span>
            <span className="cx-stake-rate">
              +{pct(t.rate)} <small>reward</small>
            </span>
            <span className="cx-stake-mono cx-stake-muted">{fmt(value * (1 + t.rate))} at unlock</span>
          </button>
        ))}
      </div>

      <div className="cx-stake-grid">
        <section className="cx-stake-panel">
          <div className="cx-field">
            <span className="cx-field-label">Amount</span>
            <div className="cx-stake-amount">
              <label className="cx-amount">
                <span className="cx-sr">Amount in FINO</span>
                <input inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
                <span>FINO</span>
              </label>
              <div className="cx-quick">
                {[1_000, 10_000, 100_000].map((q) => (
                  <button key={q} type="button" onClick={() => setAmount(String(q))}>
                    {fmt(q)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <table className="cx-stake-table">
            <thead>
              <tr>
                <th>Term</th>
                <th>Reward rate</th>
                <th>Reward</th>
                <th>You receive</th>
              </tr>
            </thead>
            <tbody>
              {TERMS.map((t, i) => (
                <tr key={t.days} className={i === pick ? "is-on" : undefined} onClick={() => setPick(i)}>
                  <td>{t.days} days</td>
                  <td>{pct(t.rate)}</td>
                  <td className="cx-stake-good">+{fmt(value * t.rate)}</td>
                  <td className="cx-stake-mono">
                    {fmt(value * (1 + t.rate))} <span className="cx-stake-muted">$FINO</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <aside className="cx-stake-panel cx-stake-ticket">
          <div className="cx-stake-ticket-head">
            <img src="/landing/mark-finity.png" alt="" />
            <div>
              <div className="cx-stake-label">Ticket</div>
              <strong>
                {term.days} days · +{pct(term.rate)}
              </strong>
            </div>
          </div>
          <div>
            <div className="cx-stake-label">You receive</div>
            <div className="cx-stake-big">{fmt(value + reward)}</div>
            <div className="cx-stake-good">+{fmt(reward)} reward</div>
          </div>
          <div className="cx-stake-unlock">
            <div className="cx-stake-label">Unlocks</div>
            <div className="cx-stake-mono">{unlock}</div>
            <div className="cx-stake-muted">Principal + reward land automatically.</div>
          </div>
          <ConnectFirst label="Connect to lock">
            <button type="button" className="cx-btn" aria-disabled="true">
              Opens at the $FINO launch
            </button>
          </ConnectFirst>
          <p className="cx-hint">Locks $FINO in the staking vault until the unlock time. Staking opens when $FINO launches.</p>
        </aside>
      </div>

      <section className="cx-stake-panel">
        <div className="cx-stake-label">Locked $FINO</div>
        <p className="cx-stake-muted" style={{ margin: "6px 0 0" }}>
          {connected ? "No locks yet. Your locks and unlock times show here." : "Connect a wallet to see your locks and unlock times."}
        </p>
      </section>

      <section className="cx-stake-panel">
        <H right={<Pill>At launch</Pill>}>$FINO chart</H>
        <div className="cx-stake-chart">
          <span>The $FINO price chart appears here when the token launches.</span>
        </div>
      </section>

      <section className="cx-stake-panel">
        <H>How staking works</H>
        <div className="cx-stake-faq">
          <div>
            <strong>Fixed terms, fixed rewards</strong>
            <p>Pick 7, 30, 90, 180 or 365 days. The reward is set when you lock and paid with your principal at unlock.</p>
          </div>
          <div>
            <strong>Nothing to claim</strong>
            <p>At the unlock time the principal and reward return to your wallet automatically.</p>
          </div>
          <div>
            <strong>Lower loan fees</strong>
            <p>While a stake is locked, every Finity loan from that wallet pays a lower fee.</p>
          </div>
          <div>
            <strong>Locked means locked</strong>
            <p>A stake can&apos;t be withdrawn early, so pick a term you&apos;re comfortable with.</p>
          </div>
        </div>
        <div style={{ marginTop: 18 }}>
          <Note icon="clock">Staking is a preview: it opens when the $FINO token launches. No tokens move on this page today.</Note>
        </div>
      </section>
    </div>
  );
}
