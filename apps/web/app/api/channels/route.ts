import { randomInt } from "node:crypto";
import { channelSupport, isPushEndpoint, sendTo, vapidKeys } from "@finity/solana/notify/deliver";
import {
  CHANNEL_KINDS, canSendCode, channels, confirmPending, pendingChannel, removeChannel, setChannel, startPending, type ChannelKind,
} from "@finity/solana/notify";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE, walletOf } from "@/lib/session";

const signedIn = async () => walletOf((await cookies()).get(COOKIE)?.value);
const unauthorised = () => NextResponse.json({ error: "sign in first" }, { status: 401 });

/** The wallet's delivery channels, what this server supports, and the push key browsers subscribe with. */
export async function GET() {
  const wallet = await signedIn();
  if (!wallet) return unauthorised();
  // Targets are the wallet's own (email address, chat id); a push subscription is shown only as "on".
  const list = channels(wallet).map((c) => ({ kind: c.kind, target: c.kind === "webpush" ? "this browser" : c.target }));
  const pending = (["email", "telegram"] as ChannelKind[]).flatMap((k) => {
    const p = pendingChannel(wallet, k);
    return p ? [{ kind: k, target: p.target }] : [];
  });
  return NextResponse.json({ channels: list, pending, support: channelSupport(), vapidPublicKey: vapidKeys().publicKey });
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const CHAT_ID = /^-?\d{4,20}$/;

function valid(kind: ChannelKind, target: unknown): string | null {
  if (kind === "email") return typeof target === "string" && EMAIL.test(target.trim()) ? target.trim() : null;
  if (kind === "telegram") return typeof target === "string" && CHAT_ID.test(target.trim()) ? target.trim() : null;
  // A PushSubscription: an https endpoint and its keys.
  const s = target as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  // Only the browsers' push services: the server later sends requests to this endpoint.
  const ok = !!s && isPushEndpoint(s.endpoint) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
  return ok ? JSON.stringify({ endpoint: s!.endpoint, keys: { p256dh: s!.keys!.p256dh, auth: s!.keys!.auth } }) : null;
}

/**
 * Turns a channel on. Browser push: { kind: "webpush", target: subscription } turns on at once (the browser itself
 * created it). Email / Telegram: { kind, target } sends a 6-digit code there and returns { pending: true }; then
 * { kind, code } with that code turns the channel on, so nobody can point alerts at an address they don't control.
 */
export async function POST(req: Request) {
  const wallet = await signedIn();
  if (!wallet) return unauthorised();
  const body = (await req.json().catch(() => null)) as { kind?: string; target?: unknown; code?: unknown } | null;
  const kind = body?.kind as ChannelKind;
  if (!CHANNEL_KINDS.includes(kind)) return NextResponse.json({ error: "unknown channel" }, { status: 400 });
  if (kind !== "webpush" && typeof body?.code === "string") {
    const r = confirmPending(wallet, kind, body.code.trim());
    if (r === "ok") return NextResponse.json({ ok: true });
    return NextResponse.json({ error: r === "wrong" ? "That code doesn't match." : "The code expired; send a new one." }, { status: 400 });
  }
  const target = valid(kind, body?.target);
  if (!target) return NextResponse.json({ error: kind === "email" ? "That isn't an email address." : kind === "telegram" ? "A Telegram chat id is a number." : "Invalid push subscription." }, { status: 400 });
  if (kind === "webpush") {
    setChannel(wallet, kind, target);
    return NextResponse.json({ ok: true });
  }
  const refused = canSendCode(wallet, kind, target);
  if (refused) return NextResponse.json({ error: refused }, { status: 429 });
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  try {
    await sendTo(kind, target, "Your Finity confirmation code", `Your code is ${code}. Enter it in Finity's Settings within 15 minutes to turn on ${kind} alerts. If you didn't ask for this, ignore it.`);
  } catch (e) {
    // Details stay in the server log; the browser only learns that sending failed.
    console.error(`channels: sending a ${kind} code failed:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: kind === "email" || kind === "telegram" ? `Couldn't send the code by ${kind}. Check the address, or try later.` : "Couldn't send the code." }, { status: 502 });
  }
  startPending(wallet, kind, target, code);
  return NextResponse.json({ pending: true });
}

/** Turns a channel off. Body: { kind }. */
export async function DELETE(req: Request) {
  const wallet = await signedIn();
  if (!wallet) return unauthorised();
  const body = (await req.json().catch(() => null)) as { kind?: string } | null;
  const kind = body?.kind as ChannelKind;
  if (!CHANNEL_KINDS.includes(kind)) return NextResponse.json({ error: "unknown channel" }, { status: 400 });
  removeChannel(wallet, kind);
  return NextResponse.json({ ok: true });
}
