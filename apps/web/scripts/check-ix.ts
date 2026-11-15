// Sends the web app's own instruction builders (lib/solana.ts `ix`) to devnet with a throwaway wallet, so the account
// wiring behind every button is checked without a browser wallet. Run: pnpm -s tsx scripts/check-ix.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { DEVNET, finityProgram, marketPda, positionPda, fromUnits } from "@finity/solana";
import { PublicKey } from "@solana/web3.js";

import { USDC_MINT, humanError, ix, type Market } from "../lib/solana";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const user = Keypair.generate();
const program = finityProgram(new AnchorProvider(conn, new Wallet(user), { commitment: "confirmed" }));
const send = async (what: string, ixs: Awaited<ReturnType<typeof ix.faucet>>) => {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [user]);
    console.log("ok  ", what, sig.slice(0, 16));
  } catch (e) {
    console.log("FAIL", what, humanError(e));
    throw e;
  }
};

await sendAndConfirmTransaction(
  conn,
  new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: user.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL })),
  [funder],
);
const mint = new PublicKey(DEVNET.mints.MSFT!);
const a = await program.account.market.fetch(marketPda(mint));
const m = { key: marketPda(mint), mint, symbol: "MSFT" } as Market;
const { BN } = await import("@anchor-lang/core");

await send("faucet MSFT", await ix.faucet(program, user.publicKey, mint, 2, 6));
await send("faucet USDC", await ix.faucet(program, user.publicKey, USDC_MINT, 5, 6));
await send("deposit 2 MSFT", await ix.deposit(program, user.publicKey, m, new BN(2_000_000)));
const limit = fromUnits(a.price) * 2 * (a.maxLtvBps / 10_000);
await send("borrow 100 USDC", await ix.borrow(program, user.publicKey, m, new BN(100_000_000)));
try {
  await send(`borrow over limit (${limit.toFixed(0)})`, await ix.borrow(program, user.publicKey, m, new BN(Math.ceil(limit * 1e6))));
} catch {
  /* expected: printed above with the program's message */
}
await send("repay 105 (all)", await ix.repay(program, user.publicKey, m, new BN(105_000_000)));
await send("withdraw 2 MSFT", await ix.withdraw(program, user.publicKey, m, new BN(2_000_000)));
const p = await program.account.position.fetch(positionPda(m.key, user.publicKey));
console.log("final position: collateral", p.collateral.toString(), "borrow shares", p.borrowShares.toString());
