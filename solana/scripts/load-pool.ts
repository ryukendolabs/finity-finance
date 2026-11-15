// Stage 3 setup (idempotent): the protocol reserve, one underwriter pool per venue (XNYS: the stocks, USBANK: the
// T-Bill fund), each market's pool membership, and each market's column of the calibrated joint stress set.
import { readFileSync } from "node:fs";

import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import {
  DEVNET,
  MARKETS,
  calendarPda,
  clockPda,
  configPda,
  jointPda,
  marketPda,
  poolEscrowPda,
  poolPda,
  poolSharesPda,
  reservePda,
  toUnits,
  usdcVaultPda,
  venueBytes,
} from "../client/index";
import { log, setup } from "./env";

const CAL = new URL("../data/calibration/", import.meta.url);
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, CAL), "utf8"));
const JOINT: Record<string, string> = { XNYS: "joint/joint-38f0d2af.json", USBANK: "nav/joint-f75706dc.json" };

const { payer, connection, program } = setup();
const POOL_ACCOUNT_LEN = 432;
const config = configPda();
const exists = async (k: PublicKey) => (await connection.getAccountInfo(k)) !== null;
if (!DEVNET.usdcMint) throw new Error("client/devnet.json is empty: run `pnpm seed` first");

if (!(await exists(reservePda()))) {
  await program.methods.initReserve().accountsPartial({ admin: payer.publicKey, config, reserve: reservePda(), systemProgram: SystemProgram.programId }).rpc();
  log("protocol reserve created");
}

for (const venue of ["XNYS", "USBANK"] as const) {
  const pool = poolPda(venue);
  if (!(await exists(pool))) {
    await program.methods
      .initPool(Array.from(venueBytes(venue)))
      .accountsPartial({
        admin: payer.publicKey, config, calendar: calendarPda(venue), pool, shareMint: poolSharesPda(venue), escrow: poolEscrowPda(venue),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    log(venue, "pool created");
  }
  // Pools created before the inventory fields grow to the current size once (idempotent: skipped when sized).
  // 8 + UnderwriterPool::INIT_SPACE (Anchor's TS `size` ignores the markets vector's max_len, so it's spelled out).
  const need = POOL_ACCOUNT_LEN;
  const info = await connection.getAccountInfo(pool);
  if (info && info.data.length < need) {
    await program.methods.migratePool().accountsPartial({ admin: payer.publicKey, config, pool, systemProgram: SystemProgram.programId }).rpc();
    log(venue, `pool migrated ${info.data.length} → ${need} bytes`);
  }
  const joint = read(JOINT[venue]!);
  const members = (await program.account.underwriterPool.fetch(pool)).markets.map((k) => k.toBase58());
  for (const spec of MARKETS.filter((m) => m.venue === venue)) {
    const market = marketPda(new PublicKey(DEVNET.mints[spec.symbol]!));
    if (!members.includes(market.toBase58())) {
      await program.methods.addPoolMarket().accountsPartial({ admin: payer.publicKey, config, pool, market, clock: clockPda(market) }).rpc();
      log(venue, `pool += ${spec.symbol}`);
    }
    const i = (joint.assets as string[]).findIndex((a) => a.startsWith(`${spec.symbol}:`));
    if (i < 0) throw new Error(`${spec.symbol}: not in ${JOINT[venue]}`);
    const z = joint.z[i] as number[];
    const hash = Array.from(Buffer.from((joint.columnHashes[i] as string).slice(2), "hex"));
    const current = (await exists(jointPda(market))) ? await program.account.jointColumn.fetch(jointPda(market)) : null;
    if (current && Buffer.from(current.hash).equals(Buffer.from(hash))) continue;
    await program.methods
      .setJointColumn(hash, z)
      .accountsPartial({ admin: payer.publicKey, config, market, joint: jointPda(market), systemProgram: SystemProgram.programId })
      .rpc();
    log(spec.symbol, `joint column: k=${z.length}, worst z ${Math.min(...z)}, hash ${(joint.columnHashes[i] as string).slice(0, 10)}…`);
  }
}
// First-loss capital: the admin deposits like the first underwriter (between epochs, at NAV).
const SEED: Record<string, number> = { XNYS: Number(process.env.POOL_XNYS_USDC ?? 500_000), USBANK: Number(process.env.POOL_USBANK_USDC ?? 200_000) };
const usdcMint = new PublicKey(DEVNET.usdcMint);
const adminUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
const ata = { tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
for (const venue of ["XNYS", "USBANK"] as const) {
  const pool = poolPda(venue);
  const p = await program.account.underwriterPool.fetch(pool);
  if (!p.cash.isZero() || p.epochActive) continue;
  const amount = toUnits(SEED[venue]!);
  await program.methods.adminMint(amount).accountsPartial({ admin: payer.publicKey, config, usdcMint, adminUsdc, ...ata }).rpc();
  await program.methods
    .poolDeposit(amount)
    .accountsPartial({
      owner: payer.publicKey, config, pool, usdcMint, shareMint: poolSharesPda(venue), ownerUsdc: adminUsdc,
      ownerShares: getAssociatedTokenAddressSync(poolSharesPda(venue), payer.publicKey), usdcVault: usdcVaultPda(), ...ata,
    })
    .rpc();
  log(venue, `pool funded with ${SEED[venue]} USDC`);
}
log("pools loaded");
