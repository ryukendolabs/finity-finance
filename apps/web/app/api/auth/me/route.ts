import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE, walletOf } from "@/lib/session";

export async function GET() {
  return NextResponse.json({ wallet: walletOf((await cookies()).get(COOKIE)?.value) });
}
