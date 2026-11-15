"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { H, KV, Note, PageHead, StatBlock } from "../ui";
import { ConnectNote } from "./shared";
import { useApp } from "@/lib/app";
import { CLUSTER_NAME, ticker } from "@/lib/protocol";
import { autoCoverIx, humanError, useAutoCover, useProgram, useSend, type Position } from "@/lib/solana";
import { deleteChannel, saveChannel, subscribePush, unsubscribePush, useChannels, useSiws, type ChannelKind } from "@/lib/siws";
import { useQueryClient } from "@tanstack/react-query";

const CHANNEL_LABEL: Record<ChannelKind, string> = { webpush: "Browser notifications", email: "Email", telegram: "Telegram" };
const OFF_HINT: Record<ChannelKind, string> = {
  webpush: "",
  email: "Not set up on this server (it needs an SMTP_URL).",
  telegram: "Not set up on this server (it needs a TELEGRAM_BOT_TOKEN).",
};

/** Where alerts go besides the in-app inbox. Needs Sign-In With Solana (the same as Alerts). */
function Notifications() {
  const s = useSiws();
  const q = useChannels(s.signedIn);
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<ChannelKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!s.signedIn) {
    return (
      <div>
        <p className="cx-page-sub" style={{ margin: "0 0 12px" }}>Sign in with your wallet (one signature, no transaction) to choose where alerts are sent.</p>
        <button type="button" className="cx-btn" aria-disabled={s.busy || undefined} onClick={() => !s.busy && s.signIn()}>
          {s.busy ? "Check your wallet…" : "Sign in"}
        </button>
        {s.error && <p className="cx-hint is-bad">{s.error}</p>}
      </div>
    );
  }
  const data = q.data;
  const on = (k: ChannelKind) => data?.channels.find((c) => c.kind === k);
  const run = async (k: ChannelKind, f: () => Promise<void>) => {
    setError(null);
    setBusy(k);
    try {
      await f();
      await qc.invalidateQueries({ queryKey: ["channels"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {(["webpush", "email", "telegram"] as ChannelKind[]).map((k) => {
        const current = on(k);
        const supported = data?.support[k] ?? false;
        return (
          <div key={k}>
            <label className="cx-switch">
              <span>
                {CHANNEL_LABEL[k]}
                {current && k !== "webpush" ? `: ${current.target}` : ""}
                {busy === k ? " · saving…" : ""}
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={!!current}
                disabled={!data || busy !== null || (!supported && !current)}
                onChange={() =>
                  run(k, async () => {
                    if (current) {
                      if (k === "webpush") await unsubscribePush();
                      await deleteChannel(k);
                    } else if (k === "webpush") {
                      await saveChannel(k, await subscribePush(data!.vapidPublicKey));
                    } else {
                      const v = (draft[k] ?? "").trim();
                      if (!v) throw new Error(k === "email" ? "Enter your email address first." : "Enter your Telegram chat id first.");
                      await saveChannel(k, v);
                    }
                  })
                }
              />
            </label>
            {!current && k !== "webpush" && supported && (
              <input
                className="cx-text-input"
                aria-label={k === "email" ? "Email address for alerts" : "Telegram chat id for alerts"}
                inputMode={k === "telegram" ? "numeric" : "email"}
                placeholder={k === "email" ? "you@example.com" : "Chat id (message @userinfobot to see yours)"}
                value={draft[k] ?? ""}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            )}
            {!supported && !current && <p className="cx-hint">{OFF_HINT[k]}</p>}
          </div>
        );
      })}
      {error && <p className="cx-hint is-bad">{error}</p>}
    </div>
  );
}

/** Auto-cover lives on-chain per loan; switching it sends `set_auto_cover`. */
function AutoCover({ p, on }: { p: Position; on: boolean }) {
  const { publicKey } = useWallet();
  const program = useProgram();
  const send = useSend();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (!publicKey) return;
    setError(null);
    try {
      const sym = ticker(p.market.symbol);
      await send(await autoCoverIx(program, publicKey, p.market, !on), setBusy, {
        icon: "shield", title: `Auto-cover ${on ? "off" : "on"} for ${sym}`, amount: "", kind: "borrow",
      });
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <label className="cx-switch">
        <span>
          {ticker(p.market.symbol)} loan: auto-cover at the Bell deadline (premium added to debt){busy ? ` · ${busy}` : ""}
        </span>
        <input type="checkbox" role="switch" checked={on} disabled={!!busy} onChange={toggle} />
      </label>
      {error && <p className="cx-hint is-bad">{error}</p>}
    </div>
  );
}

export function SettingsView() {
  const app = useApp();
  const state = useAutoCover(app.loans).data ?? {};
  return (
    <>
      <PageHead title="Settings" sub="How the app behaves for you. Loan settings live on-chain, per loan." />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H>Loans</H>
            {!app.isConnected ? (
              <ConnectNote>Connect a wallet to change your loans&apos; settings.</ConnectNote>
            ) : app.loans.length === 0 ? (
              <p className="cx-page-sub" style={{ margin: 0 }}>Auto-cover is set per loan; open a loan on Borrow first.</p>
            ) : (
              <div style={{ display: "grid", gap: 16 }}>
                {app.loans.map((p) => (
                  <AutoCover key={p.key.toBase58()} p={p} on={state[p.key.toBase58()] ?? true} />
                ))}
              </div>
            )}
          </section>
          <section>
            <H>Notifications</H>
            <Notifications />
          </section>
          <Note icon="bell">
            Every alert also lands in your Alerts inbox: the Bell, loans close to an auction, auctions your loan joins, epoch results and
            withdrawals ready to claim.
          </Note>
          <Note icon="shield">
            With auto-cover off, a loan still above the closure-safe LTV at the Bell deadline has just enough collateral sold in the
            pre-close batch (the last 5 minutes before the close) to reach the safe LTV, at a 1% penalty instead of 3%.
          </Note>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Language" value="EN" chip="English" />
          <KV rows={[["Network", CLUSTER_NAME], ["Theme", "Light"], ["Time zone", "US Eastern (market time)"]]} />
        </aside>
      </div>
    </>
  );
}
