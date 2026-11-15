import { PROGRAM_ID } from "@finity/solana";
import { NextResponse } from "next/server";

/**
 * Solana JSON-RPC proxy for the browser. The upstream endpoint (a private QuickNode URL with its token) comes from
 * the server's SOLANA_RPC_URL and never reaches the client; without it, the public devnet RPC is used. Only
 * JSON-RPC POSTs of the methods the app uses are forwarded, so the endpoint can't be used as a general proxy:
 * program-account scans only over the Finity program and with filters, same-origin browser requests only, at most
 * 10 calls per batch and a per-client rate limit.
 */
const UPSTREAM = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getTokenAccountBalance",
  "getTokenSupply", "getParsedTokenAccountsByOwner", "getTokenAccountsByOwner", "getLatestBlockhash",
  "getSignatureStatuses", "getTransaction", "getSlot", "getBlockHeight", "getEpochInfo", "getMinimumBalanceForRentExemption",
  "getFeeForMessage", "getRecentPrioritizationFees", "sendTransaction", "simulateTransaction", "getGenesisHash", "getVersion",
  "getHealth", "isBlockhashValid",
]);

type RpcCall = { method?: unknown; params?: unknown };

const MAX_BATCH = 10;
/** Requests per client per minute (a page load plus its polling stays well under). */
const RATE_PER_MIN = 600;
const buckets = new Map<string, { n: number; reset: number }>();
function limited(client: string): boolean {
  const now = Date.now();
  const b = buckets.get(client);
  if (!b || now >= b.reset) {
    if (buckets.size > 10_000) buckets.clear();
    buckets.set(client, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++b.n > RATE_PER_MIN;
}

const PROGRAM = PROGRAM_ID.toBase58();
/** getProgramAccounts only over the Finity program and with at least one filter (no whole-chain scans). */
function allowed(c: RpcCall): boolean {
  if (typeof c.method !== "string" || !ALLOWED.has(c.method)) return false;
  if (c.method !== "getProgramAccounts") return true;
  const p = Array.isArray(c.params) ? c.params : [];
  const filters = (p[1] as { filters?: unknown } | undefined)?.filters;
  return p[0] === PROGRAM && Array.isArray(filters) && filters.length > 0;
}

const deny = (message: string, status = 400) => NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message } }, { status });

export async function POST(req: Request) {
  // Browsers send Origin on POST: a page on another site can't use this proxy.
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return deny("cross-origin requests are not allowed", 403);
  const client = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
  if (limited(client)) return deny("rate limited", 429);
  const body = (await req.json().catch(() => null)) as RpcCall | RpcCall[] | null;
  const calls = Array.isArray(body) ? body : body ? [body] : [];
  if (!calls.length || calls.length > MAX_BATCH || !calls.every(allowed)) return deny("method not allowed");
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return new NextResponse(res.body, { status: res.status, headers: { "content-type": "application/json" } });
}
