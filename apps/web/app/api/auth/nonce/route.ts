import { randomBytes } from "node:crypto";
import { issueNonce } from "@finity/solana/notify";
import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { signInMessage } from "@/lib/session";

/** A one-time nonce and the exact message the wallet must sign. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { wallet?: unknown } | null;
  let wallet: string;
  try {
    wallet = new PublicKey(String(body?.wallet ?? "")).toBase58();
  } catch {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }
  const nonce = randomBytes(16).toString("hex");
  const message = signInMessage(wallet, nonce, new Date().toISOString());
  issueNonce(nonce, wallet, message); // only this exact message, for this wallet, can be signed in with
  return NextResponse.json({ nonce, message });
}
