// End-to-end user flow with a throwaway wallet: faucet → deposit → borrow → repay → withdraw.
// `--liquidation` (local validator only: it moves the price as admin) instead borrows to the limit,
// drops the price 50% and leaves the position for `BOT_SKIP_PRICES=1 pnpm bot --once` to liquidate.
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { AnchorProvider, Wallet } from "@anchor-lang/core";

import {
  BN,
  DEVNET,
  deadSharesPda,
  configPda,
  finityProgram,
  fromUnits,
  marketPda,
  positionHealth,
  positionPda,
  guardianPda,
  oraclePda,
  riskAccounts,
  riskComputeBudget,
  venueOf,
  seniorPda,
  shareMintPda,
  toUnits,
  usdcVaultPda,
  vaultPda,
} from "../client/index";
import { log, setup } from "./env";

const SYMBOL = process.env.SYMBOL ?? "AAPL";
const liquidation = process.argv.includes("--liquidation");

const { payer, connection, provider: adminProvider, program: admin } = setup();
const user = Keypair.generate();
await adminProvider.sendAndConfirm(
  new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })),
);
const program = finityProgram(new AnchorProvider(connection, new Wallet(user), { commitment: "confirmed" }));

const config = configPda();
const usdcMint = new PublicKey(DEVNET.usdcMint);
const mint = new PublicKey(DEVNET.mints[SYMBOL]!);
const market = marketPda(mint);
const position = positionPda(market, user.publicKey);
const userStock = getAssociatedTokenAddressSync(mint, user.publicKey);
const userUsdc = getAssociatedTokenAddressSync(usdcMint, user.publicKey);
const common = { tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
const ata = { associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID };

const health = async () => positionHealth(await program.account.market.fetch(market), await program.account.position.fetch(position));

log("user", user.publicKey.toBase58(), "market", SYMBOL);
await program.methods.faucet(toUnits(10)).accountsPartial({ user: user.publicKey, config, mint, userToken: userStock, ...common, ...ata }).rpc();
await program.methods
  .deposit(toUnits(10))
  .accountsPartial({ owner: user.publicKey, market, position, ownerCollateral: userStock, vault: vaultPda(market), ...common })
  .rpc();
let h = await health();
log(`deposited 10 ${SYMBOL}: value ${h.value.toFixed(2)} USDC, borrow limit ${h.borrowLimit.toFixed(2)}`);

const borrowAmt = Math.floor((liquidation ? h.borrowLimit : h.borrowLimit / 2) * 1e6) / 1e6;
await program.methods
  .borrow(toUnits(borrowAmt))
  .accountsPartial({ owner: user.publicKey, config, senior: seniorPda(), market, position, ...riskAccounts(market, venueOf(SYMBOL)), policy: null, guardianState: guardianPda(), usdcMint, ownerUsdc: userUsdc, usdcVault: usdcVaultPda(), ...common, ...ata })
  .preInstructions([riskComputeBudget()])
  .rpc();
h = await health();
log(`borrowed ${borrowAmt} USDC: debt ${h.debt.toFixed(2)}`);

if (liquidation) {
  const m = await admin.account.market.fetch(market);
  const dropped = m.price.divn(2);
  await admin.methods.setPrice(dropped).accountsPartial({ authority: payer.publicKey, config, market, oracle: oraclePda() }).rpc();
  h = await health();
  log(`price -50% → ${fromUnits(dropped)}: debt ${h.debt.toFixed(2)} vs liquidation limit ${h.liqLimit.toFixed(2)}, liquidatable=${h.liquidatable}`);
  log("POSITION", position.toBase58());
  process.exit(0);
}

// Interest accrues every second, so repaying everything takes a little more than was borrowed.
await program.methods.faucet(toUnits(101)).accountsPartial({ user: user.publicKey, config, mint: usdcMint, userToken: userUsdc, ...common, ...ata }).rpc();
await program.methods
  .repay(toUnits(borrowAmt + 1))
  .accountsPartial({ owner: user.publicKey, config, senior: seniorPda(), market, position, ownerUsdc: userUsdc, usdcVault: usdcVaultPda(), tokenProgram: TOKEN_PROGRAM_ID })
  .rpc();
await program.methods
  .withdraw(toUnits(10))
  .accountsPartial({ owner: user.publicKey, senior: seniorPda(), market, position, ...riskAccounts(market, venueOf(SYMBOL)), policy: null, guardianState: guardianPda(), ownerCollateral: userStock, vault: vaultPda(market), tokenProgram: TOKEN_PROGRAM_ID })
  .preInstructions([riskComputeBudget()])
  .rpc();
const p = await program.account.position.fetch(position);
log(`repaid and withdrew: collateral ${fromUnits(p.collateral)}, borrow shares ${p.borrowShares.toString()}`);
if (!p.collateral.isZero() || !p.borrowShares.isZero()) throw new Error("smoke test failed: position not empty");

// Lend: deposit 100 USDC into the senior vault and redeem every share straight back.
const v = await program.account.seniorVault.fetch(seniorPda());
const marketsMeta = v.markets.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
const userShares = getAssociatedTokenAddressSync(shareMintPda(), user.publicKey);
const vaultCommon = { owner: user.publicKey, config, senior: seniorPda(), usdcMint, shareMint: shareMintPda(), usdcVault: usdcVaultPda(), ...common, ...ata };
await program.methods
  .lendDeposit(toUnits(100))
  .accountsPartial({ ...vaultCommon, ownerUsdc: userUsdc, ownerShares: userShares, deadShares: deadSharesPda() })
  .remainingAccounts(marketsMeta)
  .rpc();
const shares = (await connection.getTokenAccountBalance(userShares)).value.amount;
await program.methods
  .lendRedeem(new BN(shares))
  .accountsPartial({ ...vaultCommon, ownerShares: userShares, ownerUsdc: userUsdc })
  .remainingAccounts(marketsMeta)
  .rpc();
log(`lent 100 USDC for ${fromUnits(new BN(shares), 9)} shares and redeemed them`);
log("SMOKE OK");
