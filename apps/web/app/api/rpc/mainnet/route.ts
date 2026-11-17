import { LEND_PROGRAM_ID } from "@finity/solana/lend";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";

import { rpcProxy } from "@/lib/rpcProxy";

/**
 * Mainnet JSON-RPC proxy for Finity Lend (see lib/rpcProxy.ts for the rules): reading the markets, vaults,
 * positions and the wallet's token accounts, and sending the transactions that borrow, repay, close a position or
 * supply the pool (USDC and xStocks: SPL Token and Token-2022). Program scans only over Lend. The upstream is the server's LEND_RPC_URL (a private mainnet
 * endpoint), else the public mainnet RPC.
 */
const proxy = rpcProxy({
  upstream: process.env.LEND_RPC_URL || "https://api.mainnet-beta.solana.com",
  methods: new Set([
    "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getLatestBlockhash",
    "getSignatureStatuses", "getMinimumBalanceForRentExemption", "getFeeForMessage", "sendTransaction",
    "simulateTransaction", "getSlot", "getBlockHeight", "getHealth", "isBlockhashValid",
  ]),
  programs: [LEND_PROGRAM_ID.toBase58()],
  // Lend transactions and the token-account, token and compute-budget instructions they carry; System Program
  // calls only as createAccount owned by Lend (a new position).
  txPrograms: [
    LEND_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(),
  ],
  createOwner: LEND_PROGRAM_ID.toBase58(),
  requireOrigin: true,
});

export async function POST(req: Request) {
  return proxy(req);
}
