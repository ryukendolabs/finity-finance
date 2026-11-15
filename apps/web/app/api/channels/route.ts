import { channelSupport, vapidKeys } from "@finity/solana/notify/deliver";
import { CHANNEL_KINDS, channels, removeChannel, setChannel, type ChannelKind } from "@finity/solana/notify";
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
  return NextResponse.json({ channels: list, support: channelSupport(), vapidPublicKey: vapidKeys().publicKey });
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const CHAT_ID = /^-?\d{4,20}$/;

function valid(kind: ChannelKind, target: unknown): string | null {
  if (kind === "email") return typeof target === "string" && EMAIL.test(target.trim()) ? target.trim() : null;
  if (kind === "telegram") return typeof target === "string" && CHAT_ID.test(target.trim()) ? target.trim() : null;
  // A PushSubscription: an https endpoint and its keys.
  const s = target as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const ok = !!s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://") && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
  return ok ? JSON.stringify({ endpoint: s!.endpoint, keys: { p256dh: s!.keys!.p256dh, auth: s!.keys!.auth } }) : null;
}

/** Turns a channel on (or replaces its target). Body: { kind, target }. */
export async function POST(req: Request) {
  const wallet = await signedIn();
  if (!wallet) return unauthorised();
  const body = (await req.json().catch(() => null)) as { kind?: string; target?: unknown } | null;
  const kind = body?.kind as ChannelKind;
  if (!CHANNEL_KINDS.includes(kind)) return NextResponse.json({ error: "unknown channel" }, { status: 400 });
  const target = valid(kind, body?.target);
  if (!target) return NextResponse.json({ error: kind === "email" ? "That isn't an email address." : kind === "telegram" ? "A Telegram chat id is a number." : "Invalid push subscription." }, { status: 400 });
  setChannel(wallet, kind, target);
  return NextResponse.json({ ok: true });
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
