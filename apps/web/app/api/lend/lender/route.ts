import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { lenderWallet } from "@/lib/lender";
import { sameOrigin } from "@/lib/sameOrigin";

/** POST { wallet } → { lender: boolean }: whether the connected wallet supplies the lending pool (the Lend page then
 *  shows its supply actions). The lender's address itself never leaves the server. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "browser requests only" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { wallet?: unknown } | null;
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(String(body?.wallet ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }
  return NextResponse.json({ lender: lenderWallet()?.equals(wallet) ?? false });
}
