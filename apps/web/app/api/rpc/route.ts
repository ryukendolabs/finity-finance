import { PROGRAM_ID } from "@finity/solana";

import { rpcProxy } from "@/lib/rpcProxy";

/**
 * Devnet JSON-RPC proxy for the full Finity program (see lib/rpcProxy.ts for the rules). The upstream is the
 * server's SOLANA_RPC_URL (a private endpoint that never reaches the client); without it, the public devnet RPC.
 */
const proxy = rpcProxy({
  upstream: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  methods: new Set([
    "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getTokenAccountBalance",
    "getTokenSupply", "getParsedTokenAccountsByOwner", "getTokenAccountsByOwner", "getLatestBlockhash",
    "getSignatureStatuses", "getTransaction", "getSlot", "getBlockHeight", "getEpochInfo", "getMinimumBalanceForRentExemption",
    "getFeeForMessage", "getRecentPrioritizationFees", "sendTransaction", "simulateTransaction", "getGenesisHash", "getVersion",
    "getHealth", "isBlockhashValid",
  ]),
  programs: [PROGRAM_ID.toBase58()],
});

export async function POST(req: Request) {
  return proxy(req);
}
