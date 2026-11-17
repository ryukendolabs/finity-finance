import { LEND_PROGRAM_ID, lendAddresses, type LendCluster } from "@finity/solana/lend";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, SystemProgram, type VersionedMessage } from "@solana/web3.js";

import { rpcProxy } from "@/lib/rpcProxy";

/**
 * Mainnet JSON-RPC proxy for Finity Lend (see lib/rpcProxy.ts for the rules): reading the markets, vaults,
 * positions and the wallet's token accounts, and sending the transactions that borrow, repay, close a position or
 * supply the pool (USDC and xStocks: SPL Token and Token-2022). Program scans only over Lend. The upstream is the server's LEND_RPC_URL (a private mainnet
 * endpoint), else the public mainnet RPC.
 */
const LEND = lendAddresses((process.env.LEND_CLUSTER || process.env.NEXT_PUBLIC_LEND_CLUSTER || "mainnet") as LendCluster);
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);

/** A transaction is relayed only if it calls Lend, or moves tokens into the Lend pool (the lender's Supply): token
 *  instructions on their own (transfers between other accounts) are not relayed. */
function forLend(msg: VersionedMessage): boolean {
  const keys = msg.staticAccountKeys;
  return msg.compiledInstructions.some((ix) => {
    const program = keys[ix.programIdIndex]?.toBase58();
    if (program === LEND_PROGRAM_ID.toBase58()) return true;
    if (!program || !TOKEN_PROGRAMS.has(program) || !LEND) return false;
    // Transfer (3): source, destination, owner. TransferChecked (12): source, mint, destination, owner.
    const dest = ix.data[0] === 3 ? ix.accountKeyIndexes[1] : ix.data[0] === 12 ? ix.accountKeyIndexes[2] : undefined;
    return dest !== undefined && !!keys[dest]?.equals(LEND.loanVault);
  });
}

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
  txRequire: forLend,
  requireOrigin: true,
});

export async function POST(req: Request) {
  return proxy(req);
}
