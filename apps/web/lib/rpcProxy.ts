import { PublicKey, SystemProgram, VersionedTransaction, type VersionedMessage } from "@solana/web3.js";
import { NextResponse } from "next/server";

/**
 * Solana JSON-RPC proxy for the browser, shared by /api/rpc (devnet, the full program) and /api/rpc/mainnet
 * (Finity Lend). The upstream endpoint (e.g. a private QuickNode URL with its token) stays on the server. Only
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
/** Set where a trusted proxy writes the client address (TRUST_PROXY_HEADERS=1 behind the server's nginx, which sets
 *  X-Real-IP); otherwise those headers are client-controlled and ignored. */
const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === "1";
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
 * The client's address as the proxy saw it. Only behind a trusted proxy (nginx sets x-real-ip; another proxy adds the
 * right-most X-Forwarded-For entry); without one, every request shares one bucket.
 */
export function clientOf(req: Request): string {
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
  /** When set, sendTransaction/simulateTransaction are forwarded only if every instruction calls one of these
   *  programs (base64 transactions only), so the upstream can't relay arbitrary transactions. */
  txPrograms?: readonly string[];
  /** With txPrograms: System Program instructions are allowed only as createAccount owned by this program. */
  createOwner?: string;
  /** With txPrograms: the transaction must also pass this (e.g. contain one of the app's own instructions). */
  txRequire?: (msg: VersionedMessage) => boolean;
  /** Refuse requests without an Origin header (non-browser clients). */
  requireOrigin?: boolean;
}

/** Whether every instruction of a base64 wire transaction calls an allowed program. */
function txAllowed(params: unknown, txPrograms: readonly string[], createOwner?: string, txRequire?: (msg: VersionedMessage) => boolean): boolean {
  const p = Array.isArray(params) ? params : [];
  const encoding = (p[1] as { encoding?: unknown } | undefined)?.encoding;
  if (typeof p[0] !== "string" || encoding !== "base64") return false;
  try {
    const msg = VersionedTransaction.deserialize(Buffer.from(p[0], "base64")).message;
    // Program ids are always static keys (lookup tables can't supply them).
    const keys = msg.staticAccountKeys;
    if (txRequire && !txRequire(msg)) return false;
    return msg.compiledInstructions.length > 0 && msg.compiledInstructions.every((ix) => {
      const k = keys[ix.programIdIndex];
      if (!k || !txPrograms.includes(k.toBase58())) return false;
      if (!createOwner || !k.equals(SystemProgram.programId)) return true;
      // SystemInstruction::CreateAccount = u32 0, lamports u64, space u64, owner [32].
      const d = Buffer.from(ix.data);
      return d.length === 52 && d.readUInt32LE(0) === 0 && new PublicKey(d.subarray(20, 52)).toBase58() === createOwner;
    });
  } catch {
    return false;
  }
}

export function rpcProxy({ upstream, methods, programs, txPrograms, createOwner, txRequire, requireOrigin }: ProxyConfig) {
  const allowed = (c: RpcCall): boolean => {
    if (typeof c.method !== "string" || !methods.has(c.method)) return false;
    if (txPrograms && (c.method === "sendTransaction" || c.method === "simulateTransaction")) return txAllowed(c.params, txPrograms, createOwner, txRequire);
    if (c.method !== "getProgramAccounts") return true;
    const p = Array.isArray(c.params) ? c.params : [];
    const filters = (p[1] as { filters?: unknown } | undefined)?.filters;
    return typeof p[0] === "string" && programs.includes(p[0]) && Array.isArray(filters) && filters.length > 0;
  };

  return async function POST(req: Request) {
    // Browsers send Origin on POST: a page on another site can't use this proxy.
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (requireOrigin && !origin) return deny("browser requests only", 403);
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
