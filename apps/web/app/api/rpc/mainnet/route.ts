import { V2_PROGRAM_ID } from "@finity/solana/v2";
import { ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";

import { rpcProxy } from "@/lib/rpcProxy";

/**
 * Mainnet JSON-RPC proxy for Finity V2 (see lib/rpcProxy.ts for the rules): reading V2 markets and positions,
 * and sending the transactions that open, adjust, Bell-check and close positions. Program scans only over V2.
 * The upstream is the server's V2_RPC_URL (a private mainnet endpoint); without it, the public mainnet RPC.
 */
const proxy = rpcProxy({
  upstream: process.env.V2_RPC_URL || "https://api.mainnet-beta.solana.com",
  methods: new Set([
    "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getLatestBlockhash",
    "getSignatureStatuses", "getMinimumBalanceForRentExemption", "getFeeForMessage", "sendTransaction",
    "simulateTransaction", "getSlot", "getBlockHeight", "getHealth", "isBlockhashValid",
  ]),
  programs: [V2_PROGRAM_ID.toBase58()],
  // Only V2 transactions, plus the createAccount (owned by V2) and compute-budget instructions they carry.
  txPrograms: [V2_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58()],
  createOwner: V2_PROGRAM_ID.toBase58(),
  requireOrigin: true,
});

export async function POST(req: Request) {
  return proxy(req);
}
