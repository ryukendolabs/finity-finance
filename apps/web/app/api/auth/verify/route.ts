import { consumeNonce, peekNonce } from "@finity/solana/notify";
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
  // The message must be exactly the one issued with its nonce, for this wallet (not just a lookalike).
  const nonce = /^Nonce: ([0-9a-f]{32})$/m.exec(body.message)?.[1] ?? "";
  const issued = peekNonce(nonce);
  if (!issued || issued.wallet !== pk.toBase58() || issued.message !== body.message) {
    return NextResponse.json({ error: "expired or unknown sign-in message" }, { status: 401 });
  }
  let ok = false;
  try {
    ok = ed25519.verify(Buffer.from(body.signature, "base64"), new TextEncoder().encode(issued.message), pk.toBytes());
  } catch {
    ok = false;
  }
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  if (!consumeNonce(nonce)) return NextResponse.json({ error: "expired or reused sign-in" }, { status: 401 });
  const s = issue(pk.toBase58());
  const res = NextResponse.json({ wallet: pk.toBase58() });
  res.cookies.set(COOKIE, s.value, { httpOnly: true, sameSite: "strict", path: "/", maxAge: s.maxAge, secure: req.url.startsWith("https") });
  return res;
}
