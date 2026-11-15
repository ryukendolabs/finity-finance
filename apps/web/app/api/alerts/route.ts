import { inbox } from "@finity/solana/notify";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE, walletOf } from "@/lib/session";

/** The signed-in wallet's alerts, newest first. */
export async function GET() {
  const wallet = walletOf((await cookies()).get(COOKIE)?.value);
  if (!wallet) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  return NextResponse.json(inbox(wallet));
}
