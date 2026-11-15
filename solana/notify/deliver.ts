// Sends filed alerts to each wallet's channels besides the inbox (server-only, run by the notifier in the keeper).
//  - email: SMTP_URL (e.g. smtps://user:pass@smtp.example.com) and SMTP_FROM; off when unset.
//  - telegram: TELEGRAM_BOT_TOKEN; the wallet saves its chat id. Off when unset.
//  - webpush: VAPID keys generated once into ~/.config/finity/vapid.json (mode 600); the browser's subscription
//    is saved by the web app. Works without any account (the browser vendor's push service delivers it).
// Every alert is tried once per channel; the result is recorded, so a broken channel never blocks the others.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import nodemailer from "nodemailer";
import webpush from "web-push";

import { pendingDeliveries, recordDelivery, removeChannel, type Alert, type ChannelKind } from "./store";

const APP_URL = process.env.FINITY_APP_URL ?? "http://localhost:3000";
const VAPID_FILE = process.env.FINITY_VAPID_FILE ?? `${homedir()}/.config/finity/vapid.json`;

/** The VAPID key pair (created on first use). The public key is what the browser subscribes with. */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  if (!existsSync(/*turbopackIgnore: true*/ VAPID_FILE)) {
    mkdirSync(/*turbopackIgnore: true*/ `${homedir()}/.config/finity`, { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ VAPID_FILE, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
  }
  return JSON.parse(readFileSync(/*turbopackIgnore: true*/ VAPID_FILE, "utf8")) as { publicKey: string; privateKey: string };
}

/** Which channels this server can deliver on. */
export function channelSupport(): Record<ChannelKind, boolean> {
  return { email: !!process.env.SMTP_URL, telegram: !!process.env.TELEGRAM_BOT_TOKEN, webpush: true };
}

/** Browser push services a subscription may point at (anything else is refused: no requests to arbitrary hosts). */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/,
];
export function isPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string") return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.port && !u.username && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

let mailer: nodemailer.Transporter | null = null;
const link = (a: Alert) => (a.url ? `${APP_URL}${a.url}` : APP_URL);

async function send(kind: ChannelKind, target: string, a: Alert): Promise<void> {
  if (kind === "email") {
    mailer ??= nodemailer.createTransport(process.env.SMTP_URL!);
    await mailer.sendMail({
      from: process.env.SMTP_FROM ?? "Finity Finance <alerts@localhost>",
      to: target,
      subject: `Finity: ${a.subject}`,
      text: `${a.body}\n\n${link(a)}\n\nYou get this because you turned on email alerts in Finity's Settings.`,
    });
  } else if (kind === "telegram") {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: target, text: `${a.subject}\n\n${a.body}\n${link(a)}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 120)}`);
  } else {
    const sub = JSON.parse(target) as { endpoint?: unknown };
    if (!isPushEndpoint(sub.endpoint)) throw new Error("push endpoint is not a known push service");
    const v = vapidKeys();
    webpush.setVapidDetails(APP_URL.startsWith("https") ? APP_URL : "mailto:alerts@localhost", v.publicKey, v.privateKey);
    await webpush.sendNotification(JSON.parse(target), JSON.stringify({ title: a.subject, body: a.body, url: a.url ?? "/app/alerts" }), { TTL: 3600 });
  }
}

/** Sends a one-off message (a confirmation code) on a channel. */
export async function sendTo(kind: ChannelKind, target: string, subject: string, body: string) {
  if (!channelSupport()[kind]) throw new Error(`${kind} is not set up on this server`);
  await send(kind, target, { id: 0, wallet: "", event: "CONFIRM", subject, body, url: "/app/settings", createdAt: Date.now(), read: false });
}

/** Delivers every pending alert on every channel it supports; returns how many went out. */
export async function deliverPending(log: (...a: unknown[]) => void = () => {}): Promise<number> {
  const support = channelSupport();
  let sent = 0;
  for (const { alert, kind, target } of pendingDeliveries()) {
    if (!support[kind]) {
      recordDelivery(alert.id, kind, "skipped: channel not configured on this server");
      continue;
    }
    try {
      await send(kind, target, alert);
      recordDelivery(alert.id, kind, "sent");
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordDelivery(alert.id, kind, `failed: ${msg}`);
      // A push subscription the browser revoked (404/410) is dropped.
      if (kind === "webpush" && /\b(404|410)\b/.test(msg)) removeChannel(alert.wallet, kind);
      log(`deliver ${kind} to ${alert.wallet.slice(0, 6)} failed:`, msg);
    }
  }
  return sent;
}
