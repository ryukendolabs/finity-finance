import { markRead } from "@finity/solana/notify";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE, walletOf } from "@/lib/session";

export async function POST(req: Request) {
  const wallet = walletOf((await cookies()).get(COOKIE)?.value);
  if (!wallet) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = body?.ids === "all" ? "all" : Array.isArray(body?.ids) ? body!.ids.filter((x): x is number => Number.isInteger(x)) : [];
  markRead(wallet, ids);
  return NextResponse.json({ ok: true });
}
