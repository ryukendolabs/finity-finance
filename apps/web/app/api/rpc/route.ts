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
const MAX_CLIENTS = 10_000;
/** Set where a trusted proxy writes the client address (TRUST_PROXY_HEADERS=1 on Vercel); otherwise those headers
 *  are client-controlled and ignored. */
const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === "1" || process.env.VERCEL === "1";
function limited(client: string): boolean {
  const now = Date.now();
  const b = buckets.get(client);
  if (!b || now >= b.reset) {
    // Drop only expired windows, so a flood of new keys can't wipe everyone else's count; past a hard cap, new
    // clients wait until windows expire instead of growing memory.
    if (buckets.size >= MAX_CLIENTS) for (const [k, v] of buckets) if (now >= v.reset) buckets.delete(k);
    if (buckets.size >= MAX_CLIENTS) return true;
    buckets.set(client, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++b.n > RATE_PER_MIN;
}

/**
 * The client's address as the platform saw it. Only behind a trusted proxy (Vercel sets x-real-ip itself; another
 * proxy adds the right-most X-Forwarded-For entry); without one, every request shares one bucket.
 */
function clientOf(req: Request): string {
  if (!TRUST_PROXY) return "local";
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").at(-1)!.trim();
  return "local";
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
  if (limited(clientOf(req))) return deny("rate limited", 429);
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
