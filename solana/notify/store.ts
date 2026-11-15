// The alert inbox (server-only): SQLite shared by the notifier (in the keeper bot) and the web app's API.
// Alerts are de-duplicated by key, so the notifier can re-derive them every tick without repeats.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export const DB_PATH = process.env.FINITY_DB ?? `${homedir()}/.local/share/finity/alerts.db`;

export type Alert = {
  id: number;
  wallet: string;
  event: string;
  subject: string;
  body: string;
  url: string | null;
  createdAt: number;
  read: boolean;
};

let db: Database.Database | null = null;

export function store(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    create table if not exists alerts (
      id integer primary key autoincrement,
      wallet text not null,
      key text not null unique,
      event text not null,
      subject text not null,
      body text not null,
      url text,
      created_at integer not null,
      read integer not null default 0
    );
    create index if not exists alerts_wallet on alerts (wallet, created_at desc);
    create table if not exists nonces (
      nonce text primary key,
      created_at integer not null
    );
    -- Where a wallet wants its alerts delivered besides the inbox: email, telegram (chat id) or webpush (JSON
    -- subscription). One per kind per wallet.
    create table if not exists channels (
      wallet text not null,
      kind text not null,
      target text not null,
      created_at integer not null,
      primary key (wallet, kind)
    );
    -- One row per alert and channel tried, so a delivery is attempted once (status: sent | failed: reason).
    create table if not exists deliveries (
      alert_id integer not null,
      kind text not null,
      status text not null,
      at integer not null,
      primary key (alert_id, kind)
    );
  `);
  return db;
}

/** Adds an alert unless one with the same key exists; returns whether it was new. */
export function addAlert(a: { wallet: string; key: string; event: string; subject: string; body: string; url?: string | null }): boolean {
  const r = store()
    .prepare("insert or ignore into alerts (wallet, key, event, subject, body, url, created_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run(a.wallet, a.key, a.event, a.subject, a.body, a.url ?? null, Date.now());
  return r.changes > 0;
}

export function inbox(wallet: string, limit = 50): { items: Alert[]; unread: number } {
  const rows = store()
    .prepare("select id, wallet, event, subject, body, url, created_at, read from alerts where wallet = ? order by created_at desc limit ?")
    .all(wallet, limit) as { id: number; wallet: string; event: string; subject: string; body: string; url: string | null; created_at: number; read: number }[];
  const unread = (store().prepare("select count(*) n from alerts where wallet = ? and read = 0").get(wallet) as { n: number }).n;
  return {
    items: rows.map((r) => ({ id: r.id, wallet: r.wallet, event: r.event, subject: r.subject, body: r.body, url: r.url, createdAt: r.created_at, read: !!r.read })),
    unread,
  };
}

export function markRead(wallet: string, ids: number[] | "all") {
  if (ids === "all") store().prepare("update alerts set read = 1 where wallet = ?").run(wallet);
  else for (const id of ids) store().prepare("update alerts set read = 1 where wallet = ? and id = ?").run(wallet, id);
}

/** One-time sign-in nonces (5-minute lifetime). */
export function issueNonce(nonce: string) {
  const s = store();
  s.prepare("delete from nonces where created_at < ?").run(Date.now() - 5 * 60_000);
  s.prepare("insert into nonces (nonce, created_at) values (?, ?)").run(nonce, Date.now());
}

export function consumeNonce(nonce: string): boolean {
  const r = store().prepare("delete from nonces where nonce = ? and created_at >= ?").run(nonce, Date.now() - 5 * 60_000);
  return r.changes > 0;
}

// ───────────── delivery channels ─────────────

export type ChannelKind = "email" | "telegram" | "webpush";
export const CHANNEL_KINDS: ChannelKind[] = ["email", "telegram", "webpush"];

export function channels(wallet: string): { kind: ChannelKind; target: string; createdAt: number }[] {
  return (store().prepare("select kind, target, created_at from channels where wallet = ?").all(wallet) as { kind: ChannelKind; target: string; created_at: number }[]).map(
    (r) => ({ kind: r.kind, target: r.target, createdAt: r.created_at }),
  );
}

export function setChannel(wallet: string, kind: ChannelKind, target: string) {
  store()
    .prepare("insert into channels (wallet, kind, target, created_at) values (?, ?, ?, ?) on conflict (wallet, kind) do update set target = excluded.target, created_at = excluded.created_at")
    .run(wallet, kind, target, Date.now());
}

export function removeChannel(wallet: string, kind: ChannelKind) {
  store().prepare("delete from channels where wallet = ? and kind = ?").run(wallet, kind);
}

/** Alerts filed since a channel was set up and not yet tried on it (oldest first, capped per call). */
export function pendingDeliveries(limit = 50): { alert: Alert; kind: ChannelKind; target: string }[] {
  const rows = store()
    .prepare(
      `select a.id, a.wallet, a.event, a.subject, a.body, a.url, a.created_at, a.read, c.kind, c.target
       from alerts a join channels c on c.wallet = a.wallet and a.created_at >= c.created_at
       left join deliveries d on d.alert_id = a.id and d.kind = c.kind
       where d.alert_id is null order by a.created_at limit ?`,
    )
    .all(limit) as { id: number; wallet: string; event: string; subject: string; body: string; url: string | null; created_at: number; read: number; kind: ChannelKind; target: string }[];
  return rows.map((r) => ({
    alert: { id: r.id, wallet: r.wallet, event: r.event, subject: r.subject, body: r.body, url: r.url, createdAt: r.created_at, read: !!r.read },
    kind: r.kind,
    target: r.target,
  }));
}

export function recordDelivery(alertId: number, kind: ChannelKind, status: string) {
  store().prepare("insert or replace into deliveries (alert_id, kind, status, at) values (?, ?, ?, ?)").run(alertId, kind, status.slice(0, 200), Date.now());
}
