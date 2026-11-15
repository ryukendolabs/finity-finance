import { NextResponse } from "next/server";

/**
 * Solana JSON-RPC proxy for the browser. The upstream endpoint (a private QuickNode URL with its token) comes from
 * the server's SOLANA_RPC_URL and never reaches the client; without it, the public devnet RPC is used. Only
 * JSON-RPC POSTs of the methods the app uses are forwarded, so the endpoint can't be used as a general proxy.
 */
const UPSTREAM = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getTokenAccountBalance",
  "getTokenSupply", "getParsedTokenAccountsByOwner", "getTokenAccountsByOwner", "getLatestBlockhash",
  "getSignatureStatuses", "getTransaction", "getSlot", "getBlockHeight", "getEpochInfo", "getMinimumBalanceForRentExemption",
  "getFeeForMessage", "getRecentPrioritizationFees", "sendTransaction", "simulateTransaction", "getGenesisHash", "getVersion",
  "getHealth", "isBlockhashValid",
]);

type RpcCall = { method?: unknown };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as RpcCall | RpcCall[] | null;
  const calls = Array.isArray(body) ? body : body ? [body] : [];
  if (!calls.length || calls.length > 100 || calls.some((c) => typeof c.method !== "string" || !ALLOWED.has(c.method))) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "method not allowed" } }, { status: 400 });
  }
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return new NextResponse(res.body, { status: res.status, headers: { "content-type": "application/json" } });
}
