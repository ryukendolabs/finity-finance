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
    -- An email address or Telegram chat waiting for its confirmation code (the channel turns on only once the code
    -- sent there comes back).
    create table if not exists channel_pending (
      wallet text not null,
      kind text not null,
      target text not null,
      code text not null,
      attempts integer not null default 0,
      created_at integer not null,
      primary key (wallet, kind)
    );
    create table if not exists deliveries (
      alert_id integer not null,
      kind text not null,
      status text not null,
      at integer not null,
      primary key (alert_id, kind)
    );
  `);
  // Older inboxes: nonces are bound to the wallet and the exact message they were issued with.
  for (const col of ["wallet text", "message text"]) {
    try {
      db.exec(`alter table nonces add column ${col}`);
    } catch {
      /* already there */
    }
  }
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

/** One-time sign-in nonces (5-minute lifetime), bound to the wallet and the exact message issued with them. */
export function issueNonce(nonce: string, wallet: string, message: string) {
  const s = store();
  s.prepare("delete from nonces where created_at < ?").run(Date.now() - 5 * 60_000);
  s.prepare("insert into nonces (nonce, created_at, wallet, message) values (?, ?, ?, ?)").run(nonce, Date.now(), wallet, message);
}

/** The live nonce's wallet and message (without using it up). */
export function peekNonce(nonce: string): { wallet: string; message: string } | null {
  const r = store().prepare("select wallet, message from nonces where nonce = ? and created_at >= ?").get(nonce, Date.now() - 5 * 60_000) as
    | { wallet: string | null; message: string | null }
    | undefined;
  return r?.wallet && r.message ? { wallet: r.wallet, message: r.message } : null;
}

/** Uses the nonce up; false if it was already used or expired. */
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

// ───────────── confirming an email address or Telegram chat ─────────────

const CODE_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

/** Records a target waiting for confirmation and returns the 6-digit code to send there. */
export function startPending(wallet: string, kind: ChannelKind, target: string, code: string) {
  store()
    .prepare(
      "insert into channel_pending (wallet, kind, target, code, attempts, created_at) values (?, ?, ?, ?, 0, ?) on conflict (wallet, kind) do update set target = excluded.target, code = excluded.code, attempts = 0, created_at = excluded.created_at",
    )
    .run(wallet, kind, target, code, Date.now());
}

export function pendingChannel(wallet: string, kind: ChannelKind): { target: string } | null {
  const r = store().prepare("select target, created_at from channel_pending where wallet = ? and kind = ?").get(wallet, kind) as
    | { target: string; created_at: number }
    | undefined;
  return r && Date.now() - r.created_at < CODE_TTL_MS ? { target: r.target } : null;
}

/** Checks a code; on a match the channel turns on. Codes expire after 15 minutes and allow 5 attempts. */
export function confirmPending(wallet: string, kind: ChannelKind, code: string): "ok" | "wrong" | "expired" {
  const s = store();
  const r = s.prepare("select target, code, attempts, created_at from channel_pending where wallet = ? and kind = ?").get(wallet, kind) as
    | { target: string; code: string; attempts: number; created_at: number }
    | undefined;
  if (!r || Date.now() - r.created_at >= CODE_TTL_MS || r.attempts >= MAX_ATTEMPTS) return "expired";
  if (r.code !== code) {
    s.prepare("update channel_pending set attempts = attempts + 1 where wallet = ? and kind = ?").run(wallet, kind);
    return "wrong";
  }
  s.prepare("delete from channel_pending where wallet = ? and kind = ?").run(wallet, kind);
  setChannel(wallet, kind, r.target);
  return "ok";
}
