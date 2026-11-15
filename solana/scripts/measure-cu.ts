// Measures compute units of a borrow with the full clock + risk path (local validator).
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { DEVNET, configPda, finityProgram, guardianPda, marketPda, positionPda, riskAccounts, seniorPda, toUnits, usdcVaultPda, vaultPda, venueOf } from "../client/index";
import { setup } from "./env";
const { payer, connection, provider } = setup();
const user = Keypair.generate();
await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })));
const program = finityProgram(new AnchorProvider(connection, new Wallet(user), { commitment: "confirmed" }));
const mint = new PublicKey(DEVNET.mints.AAPL!); const usdcMint = new PublicKey(DEVNET.usdcMint);
const market = marketPda(mint); const position = positionPda(market, user.publicKey); const config = configPda();
const c = { tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID };
const stock = getAssociatedTokenAddressSync(mint, user.publicKey);
await program.methods.faucet(toUnits(10)).accountsPartial({ user: user.publicKey, config, mint, userToken: stock, ...c }).rpc();
await program.methods.deposit(toUnits(10)).accountsPartial({ owner: user.publicKey, market, position, ownerCollateral: stock, vault: vaultPda(market), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
const sig = await program.methods.borrow(toUnits(100))
  .accountsPartial({ owner: user.publicKey, config, senior: seniorPda(), market, position, ...riskAccounts(market, venueOf("AAPL")), policy: null, guardianState: guardianPda(), usdcMint, ownerUsdc: getAssociatedTokenAddressSync(usdcMint, user.publicKey), usdcVault: usdcVaultPda(), ...c })
  .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
console.log("borrow CU:", tx?.meta?.computeUnitsConsumed);
const p = await program.methods.poke().accountsPartial({ market, clock: riskAccounts(market, "XNYS").clock, calendar: riskAccounts(market, "XNYS").calendar }).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
console.log("poke CU:", (await connection.getTransaction(p, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta?.computeUnitsConsumed);
