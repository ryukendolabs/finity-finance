// Seeds a freshly deployed Finity program: USDC + stock mints (mint authority = config PDA), config + senior
// vault, the markets (protocol parameters in client/index.ts), and lender liquidity deposited through the senior vault.
// Idempotent: rerunning skips whatever already exists. Writes client/devnet.json.
import { writeFileSync } from "node:fs";

import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountMeta } from "@solana/web3.js";

import {
  DEVNET,
  LAYOUT,
  MARKETS,
  PROGRAM_ID,
  STOCK_DECIMALS,
  USDC_DECIMALS,
  configPda,
  deadSharesPda,
  marketPda,
  seniorPda,
  shareEscrowPda,
  shareMintPda,
  toUnits,
  toWad,
  usdcVaultPda,
  vaultPda,
  type Deployment,
} from "../client/index";
import { fetchQuote } from "./quotes";
import { log, setup } from "./env";

const LIQUIDITY_USDC = Number(process.env.LIQUIDITY_USDC ?? 5_000_000);

const { payer, connection, program } = setup();
const config = configPda();
const senior = seniorPda();
const usdcVault = usdcVaultPda();
const tokenProgram = TOKEN_PROGRAM_ID;
const reuse = DEVNET.programId === PROGRAM_ID.toBase58() && DEVNET.layout === LAYOUT;

const book: Deployment = {
  cluster: "devnet",
  programId: PROGRAM_ID.toBase58(),
  layout: LAYOUT,
  usdcMint: reuse ? DEVNET.usdcMint : "",
  mints: reuse ? { ...DEVNET.mints } : {},
};
const save = () => writeFileSync(new URL("../client/devnet.json", import.meta.url), JSON.stringify(book, null, 2) + "\n");
const exists = async (k: PublicKey) => (await connection.getAccountInfo(k)) !== null;
const mint = async (decimals: number) =>
  (await createMint(connection, payer, config, null, decimals, undefined, { commitment: "confirmed" })).toBase58();

log("program", PROGRAM_ID.toBase58(), "layout", LAYOUT, "admin", payer.publicKey.toBase58());

// Config, USDC and the senior vault
if (!(await exists(config))) {
  if (!book.usdcMint) book.usdcMint = await mint(USDC_DECIMALS);
  save();
  const keeper = new PublicKey(process.env.KEEPER_PUBKEY ?? payer.publicKey.toBase58());
  await program.methods
    .initialize(keeper)
    .accountsPartial({
      admin: payer.publicKey,
      config,
      usdcMint: new PublicKey(book.usdcMint),
      usdcVault,
      senior,
      shareMint: shareMintPda(),
      shareEscrow: shareEscrowPda(),
      deadShares: deadSharesPda(),
      tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log("initialized; keeper", keeper.toBase58());
} else {
  book.usdcMint = (await program.account.config.fetch(config)).usdcMint.toBase58();
  log("config exists");
}
save();

// Markets
for (const spec of MARKETS) {
  if (!book.mints[spec.symbol]) {
    book.mints[spec.symbol] = await mint(STOCK_DECIMALS);
    save();
  }
  const mintKey = new PublicKey(book.mints[spec.symbol]!);
  const market = marketPda(mintKey);
  if (await exists(market)) {
    log(spec.symbol, "market exists");
    continue;
  }
  const q = await fetchQuote(spec.quote);
  const [r0, s1, s2, uKink] = spec.rate.map(toWad) as [ReturnType<typeof toWad>, ReturnType<typeof toWad>, ReturnType<typeof toWad>, ReturnType<typeof toWad>];
  await program.methods
    .initMarket({
      symbol: spec.symbol,
      price: toUnits(q.price),
      maxLtvBps: spec.maxLtvBps,
      closedLtvBps: spec.closedLtvBps,
      liqThresholdBps: spec.liqThresholdBps,
      liqBonusBps: spec.liqBonusBps,
      rate: { r0, s1, s2, uKink },
      supplyCap: toUnits(spec.supplyCap, 0),
      borrowCap: toUnits(spec.borrowCap, 0),
      vaultCap: toUnits(spec.vaultCap, 0),
    })
    .accountsPartial({
      admin: payer.publicKey,
      config,
      senior,
      collateralMint: mintKey,
      market,
      vault: vaultPda(market),
      tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log(spec.symbol, "market created at", q.price);
}

// Lender liquidity: the admin mints test USDC and deposits it into the senior vault like any lender.
const vaultState = await program.account.seniorVault.fetch(senior);
const total = Number(vaultState.idle.add(vaultState.totalSupplied).toString()) / 1e6;
if (total < LIQUIDITY_USDC / 2) {
  const amount = toUnits(LIQUIDITY_USDC - total);
  const usdcMint = new PublicKey(book.usdcMint);
  const adminUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
  await program.methods
    .adminMint(amount)
    .accountsPartial({
      admin: payer.publicKey, config, usdcMint, adminUsdc, tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  const markets: AccountMeta[] = vaultState.markets.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
  await program.methods
    .lendDeposit(amount)
    .accountsPartial({
      owner: payer.publicKey,
      config,
      senior,
      usdcMint,
      shareMint: shareMintPda(),
      ownerUsdc: adminUsdc,
      ownerShares: getAssociatedTokenAddressSync(shareMintPda(), payer.publicKey),
      deadShares: deadSharesPda(),
      usdcVault,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(markets)
    .rpc();
  log("deposited", LIQUIDITY_USDC - total, "USDC into the senior vault");
}
const v = await program.account.seniorVault.fetch(senior);
log("senior vault: idle", v.idle.toString(), "supplied", v.totalSupplied.toString());
save();
log("wrote client/devnet.json");
