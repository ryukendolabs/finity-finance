"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Icon } from "../Icon";
import { ConnectFirst } from "../actions";
import { Prefs } from "../Prefs";
import { H, KV, Note, PageHead, StatBlock } from "../ui";
import { ErrorNote, Loading } from "./shared";
import { useApp } from "@/lib/app";
import { markRead, useChannels, useInbox, useSiws, type ChannelKind } from "@/lib/siws";
import { et, etShort, local } from "@/lib/time";

const ICON: [RegExp, string][] = [
  [/bell/i, "bell"],
  [/auction|lot/i, "gavel"],
  [/epoch|pool|cover|claim/i, "shield"],
  [/risk|halt|pause/i, "alert"],
  [/redeem/i, "cash"],
];
const iconOf = (event: string) => ICON.find(([re]) => re.test(event))?.[1] ?? "mail";

/** The sign-in gate for wallet-private pages: connect, then sign one message. */
export function SignInGate({ why }: { why: string }) {
  const s = useSiws();
  return (
    <div style={{ display: "grid", gap: 14, justifyItems: "start" }}>
      <Note icon="lock">{why}</Note>
      <ConnectFirst label="Connect wallet">
        <button type="button" className="cx-btn" aria-disabled={s.busy || undefined} onClick={() => !s.busy && s.signIn()}>
          {s.busy ? "Check your wallet…" : "Sign in with your wallet"}
        </button>
      </ConnectFirst>
      {s.error && <p className="cx-hint is-bad">{s.error}</p>}
    </div>
  );
}

export function AlertsView() {
  const { markets } = useApp();
  const s = useSiws();
  const inbox = useInbox(s.signedIn);
  const qc = useQueryClient();
  const router = useRouter();
  const items = inbox.data?.items ?? [];
  const unread = inbox.data?.unread ?? 0;
  const clock = markets.find((m) => m.marketHours)?.clock;
  const read = async (ids: number[] | "all") => {
    await markRead(ids).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ["inbox"] });
  };

  return (
    <>
      <PageHead title="Alerts" sub="Bell notices, loans at risk, auction results, pool settlements and withdrawals for your positions." />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H
              right={
                s.signedIn && unread > 0 ? (
                  <button type="button" className="cx-chip" onClick={() => read("all")}>
                    Mark {unread} read
                  </button>
                ) : (
                  <small>{unread} unread</small>
                )
              }
            >
              Inbox
            </H>
            {!s.signedIn ? (
              <SignInGate why="Your inbox is private. Sign in with your wallet (one signature, no transaction) to read it." />
            ) : inbox.error ? (
              <ErrorNote error={inbox.error} />
            ) : inbox.isLoading ? (
              <Loading what="Loading your inbox" />
            ) : items.length === 0 ? (
              <Note icon="bell">No alerts yet. Bell notices for your loans arrive here before each risky close.</Note>
            ) : (
              <div>
                {items.map((a) => (
                  <article
                    key={a.id}
                    className="cx-alert"
                    onClick={() => {
                      if (!a.read) void read([a.id]);
                      if (a.url) router.push(a.url);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <span className="cx-tile-icon" style={{ width: 46, height: 46, margin: 0 }}>
                      <Icon name={iconOf(a.event)} size={22} strokeWidth={1.9} />
                    </span>
                    <div>
                      <h3>
                        {!a.read && <span className="cx-unread-dot" aria-label="Unread" />}
                        {a.subject}
                      </h3>
                      <p>{a.body}</p>
                    </div>
                    <time>{local(a.createdAt)}</time>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock
            label={clock?.current ? "Markets reopen" : "Next Bell deadline"}
            value={clock ? etShort(clock.current ? clock.current.reopenAt : clock.bellAt) : "—"}
            chip="ET"
          />
          <KV
            rows={[
              ["Bell window opens", et(clock?.bellWindowAt)],
              ["Market close", et(clock?.nextCloseAt)],
              ["Reopen", et(clock?.current?.reopenAt ?? clock?.nextReopenAt)],
            ]}
          />
          <ChannelSummary />
          <div>
            <H>About</H>
            <Prefs
              storageKey="cx-alert-topics"
              options={[
                { id: "bell", label: "Bell checks for my loans", initial: true },
                { id: "reopen", label: "Auction results", initial: true },
                { id: "risk", label: "Loans at risk", initial: true },
                { id: "epoch", label: "Pool epoch settlements", initial: false },
              ]}
            />
          </div>
          {s.signedIn && (
            <button type="button" className="cx-btn is-ghost" onClick={s.signOut}>
              Sign out of alerts
            </button>
          )}
        </aside>
      </div>
    </>
  );
}

/** Where this wallet's alerts go: the inbox always, plus the channels switched on in Settings. */
function ChannelSummary() {
  const s = useSiws();
  const q = useChannels(s.signedIn).data;
  const state = (k: ChannelKind) => {
    if (!s.signedIn) return "Sign in to see";
    const c = q?.channels.find((x) => x.kind === k);
    if (c) return k === "webpush" ? "On" : `On (${c.target})`;
    return q && !q.support[k] ? "Not set up on this server" : "Off";
  };
  return (
    <div>
      <H right={<a className="cx-link-btn" href="/app/settings">Change</a>}>Notify me by</H>
      <KV rows={[["In the app", "On"], ["Browser", state("webpush")], ["Email", state("email")], ["Telegram", state("telegram")]]} />
    </div>
  );
}
