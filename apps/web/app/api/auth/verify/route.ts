import { consumeNonce } from "@finity/solana/notify";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { COOKIE, issue } from "@/lib/session";

/** Checks the wallet's Ed25519 signature over the sign-in message and its single-use nonce, then sets the session. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { wallet?: string; message?: string; signature?: string } | null;
  if (!body?.wallet || !body.message || !body.signature) return NextResponse.json({ error: "missing fields" }, { status: 400 });
  let pk: PublicKey;
  try {
    pk = new PublicKey(body.wallet);
  } catch {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }
  const lines = body.message.split("\n");
  const field = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
  if (field("Wallet") !== pk.toBase58()) return NextResponse.json({ error: "message is for another wallet" }, { status: 400 });
  const ok = ed25519.verify(Buffer.from(body.signature, "base64"), new TextEncoder().encode(body.message), pk.toBytes());
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  if (!consumeNonce(field("Nonce") ?? "")) return NextResponse.json({ error: "expired or reused sign-in" }, { status: 401 });
  const s = issue(pk.toBase58());
  const res = NextResponse.json({ wallet: pk.toBase58() });
  res.cookies.set(COOKIE, s.value, { httpOnly: true, sameSite: "strict", path: "/", maxAge: s.maxAge, secure: req.url.startsWith("https") });
  return res;
}
