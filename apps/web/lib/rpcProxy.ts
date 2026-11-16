import { NextResponse } from "next/server";

/**
 * Solana JSON-RPC proxy for the browser, shared by /api/rpc (devnet, the full program) and /api/rpc/mainnet
 * (Finity V2). The upstream endpoint (e.g. a private QuickNode URL with its token) stays on the server. Only
 * JSON-RPC POSTs of the listed methods are forwarded, so the endpoint can't be used as a general proxy:
 * program-account scans only over the listed programs and with filters, same-origin browser requests only, at most
 * 10 calls per batch and a per-client rate limit (one limiter across both routes).
 */
type RpcCall = { method?: unknown; params?: unknown };

const MAX_BATCH = 10;
/** Requests per client per minute (a page load plus its polling stays well under). */
const RATE_PER_MIN = 600;
const buckets = new Map<string, { n: number; reset: number }>();
const MAX_CLIENTS = 10_000;
const OVERFLOW = "overflow";
const OVERFLOW_PER_MIN = RATE_PER_MIN * 20;
/** Set where a trusted proxy writes the client address (TRUST_PROXY_HEADERS=1 on Vercel); otherwise those headers
 *  are client-controlled and ignored. */
const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === "1" || process.env.VERCEL === "1";
function limited(clientKey: string): boolean {
  const now = Date.now();
  let client = clientKey;
  let b = buckets.get(client);
  if (!b || now >= b.reset) {
    // Drop only expired windows, so a flood of new keys can't wipe everyone else's count. Past a hard cap, new
    // clients share one overflow bucket with its own (larger) limit: memory stays bounded and nobody is locked out.
    if (buckets.size >= MAX_CLIENTS) for (const [k, v] of buckets) if (now >= v.reset) buckets.delete(k);
    if (buckets.size >= MAX_CLIENTS && client !== OVERFLOW) {
      client = OVERFLOW;
      b = buckets.get(OVERFLOW);
      if (b && now < b.reset) return ++b.n > OVERFLOW_PER_MIN;
    }
    buckets.set(client, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++b.n > (client === OVERFLOW ? OVERFLOW_PER_MIN : RATE_PER_MIN);
}

/**
 * The client's address as the platform saw it. Only behind a trusted proxy (Vercel sets x-real-ip itself; another
 * proxy adds the right-most X-Forwarded-For entry); without one, every request shares one bucket.
 */
function clientOf(req: Request): string {
  if (!TRUST_PROXY) return "local";
  const real = req.headers.get("x-real-ip")?.trim() || req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return real ? group(real) : "local";
}

/** IPv6 clients count per /64 (one host can hold a whole /64), IPv4 per address. */
function group(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head] = ip.split("::");
  const parts = ip.includes("::") ? (head ? head.split(":") : []) : ip.split(":");
  return `${[...parts, "0", "0", "0", "0"].slice(0, 4).join(":")}::/64`;
}

const deny = (message: string, status = 400) => NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message } }, { status });

export interface ProxyConfig {
  upstream: string;
  methods: ReadonlySet<string>;
  /** Programs getProgramAccounts may scan (always with at least one filter). */
  programs: readonly string[];
}

export function rpcProxy({ upstream, methods, programs }: ProxyConfig) {
  const allowed = (c: RpcCall): boolean => {
    if (typeof c.method !== "string" || !methods.has(c.method)) return false;
    if (c.method !== "getProgramAccounts") return true;
    const p = Array.isArray(c.params) ? c.params : [];
    const filters = (p[1] as { filters?: unknown } | undefined)?.filters;
    return typeof p[0] === "string" && programs.includes(p[0]) && Array.isArray(filters) && filters.length > 0;
  };

  return async function POST(req: Request) {
    // Browsers send Origin on POST: a page on another site can't use this proxy.
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return deny("cross-origin requests are not allowed", 403);
    if (limited(clientOf(req))) return deny("rate limited", 429);
    const body = (await req.json().catch(() => null)) as RpcCall | RpcCall[] | null;
    const calls = Array.isArray(body) ? body : body ? [body] : [];
    if (!calls.length || calls.length > MAX_BATCH || !calls.every(allowed)) return deny("method not allowed");
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return new NextResponse(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  };
}
