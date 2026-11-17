import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { clientOf } from "@/lib/rpcProxy";
import { sameOrigin } from "@/lib/sameOrigin";

/**
 * Network fees for the pages that run on the full protocol: when a connected wallet's balance there is low, the
 * server sends it a little SOL from its sponsor wallet (GAS_SPONSOR_KEY: a JSON array secret key, kept only on the
 * server), so people never have to find SOL for those pages themselves.
 *
 * POST { wallet } → { topped: boolean, sol }. The Origin check only stops other websites; a script can fake it, so
 * the limits are what bound the cost: one top-up per wallet per TOP_UP_EVERY_MS, PER_CLIENT_DAILY per client address
 * per day, HOURLY_CAP in total per hour (per server instance). The sponsor holds devnet SOL only, and keeps little.
 */
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const LOW = 0.01 * LAMPORTS_PER_SOL;
const TOP_UP = 0.02 * LAMPORTS_PER_SOL;
const TOP_UP_EVERY_MS = 6 * 3_600_000;
const HOURLY_CAP = 60;
const PER_CLIENT_DAILY = 3;
const DAY_MS = 86_400_000;
const byClient = new Map<string, { n: number; reset: number }>();
const MAX_ENTRIES = 50_000;
const last = new Map<string, number>();
let hour = { start: 0, n: 0 };

function sponsor(): Keypair | null {
  const raw = process.env.GAS_SPONSOR_KEY?.trim();
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    return null;
  }
}

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("browser requests only", 403);
  const body = (await req.json().catch(() => null)) as { wallet?: unknown } | null;
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(String(body?.wallet ?? ""));
  } catch {
    return fail("invalid wallet");
  }
  const payer = sponsor();
  if (!payer) return fail("Fee sponsoring is not available right now.", 503);
  const conn = new Connection(RPC, "confirmed");
  const balance = await conn.getBalance(wallet);
  if (balance >= LOW) return NextResponse.json({ topped: false, sol: balance / LAMPORTS_PER_SOL });

  const now = Date.now();
  const key = wallet.toBase58();
  const at = last.get(key);
  if (at !== undefined && now - at < TOP_UP_EVERY_MS) return NextResponse.json({ topped: false, sol: balance / LAMPORTS_PER_SOL });
  if (now - hour.start >= 3_600_000) hour = { start: now, n: 0 };
  if (hour.n >= HOURLY_CAP) return fail("Busy right now. Try again in a few minutes.", 429);
  const client = clientOf(req);
  let c = byClient.get(client);
  if (!c || now >= c.reset) {
    if (byClient.size >= MAX_ENTRIES) for (const [k, v] of byClient) if (now >= v.reset) byClient.delete(k);
    if (byClient.size >= MAX_ENTRIES) return fail("Busy right now. Try again in a few minutes.", 429);
    c = { n: 0, reset: now + DAY_MS };
    byClient.set(client, c);
  }
  if (c.n >= PER_CLIENT_DAILY) return NextResponse.json({ topped: false, sol: balance / LAMPORTS_PER_SOL });
  c.n++;
  if (last.size >= MAX_ENTRIES) for (const [k, t] of last) if (now - t >= TOP_UP_EVERY_MS) last.delete(k);
  if (last.size >= MAX_ENTRIES) return fail("Busy right now. Try again in a few minutes.", 429);
  last.set(key, now);
  hour.n++;

  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wallet, lamports: TOP_UP }),
    );
    tx.sign(payer);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return NextResponse.json({ topped: true, sol: (balance + TOP_UP) / LAMPORTS_PER_SOL });
  } catch {
    last.delete(key);
    hour.n--;
    c.n--;
    return fail("Couldn't cover the fee right now. Try again in a moment.", 502);
  }
}
