// Stage 5 setup (idempotent): three relayer node keys and a guardian key in ~/.config/finity (private, mode
// 600, never in the repo), the on-chain signer set (2 of 3, keeper pushes off) and the guardian.
// On devnet the three nodes run inside the keeper bot; in production each is a separate operator.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { Keypair, SystemProgram } from "@solana/web3.js";

import { configPda, guardianPda, oraclePda } from "../client/index";
import { log, setup } from "./env";

export const KEY_DIR = `${homedir()}/.config/finity`;
export const NODE_FILES = [1, 2, 3].map((i) => `${KEY_DIR}/relayer-${i}.json`);
const GUARDIAN_FILE = `${KEY_DIR}/guardian.json`;
const THRESHOLD = 2;

export function loadOrCreate(path: string): Keypair {
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
  mkdirSync(KEY_DIR, { recursive: true });
  const k = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(k.secretKey)));
  chmodSync(path, 0o600);
  return k;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { payer, program } = setup();
  const nodes = NODE_FILES.map(loadOrCreate);
  const guardian = loadOrCreate(GUARDIAN_FILE);
  const allowKeeper = process.env.KEEPER_PRICES === "1";
  await program.methods
    .setOracle(nodes.map((k) => k.publicKey), THRESHOLD, allowKeeper)
    .accountsPartial({ admin: payer.publicKey, config: configPda(), oracle: oraclePda(), systemProgram: SystemProgram.programId })
    .rpc();
  log(`oracle: ${THRESHOLD} of ${nodes.length} relayer signers (${nodes.map((k) => k.publicKey.toBase58().slice(0, 6)).join(", ")}), keeper pushes ${allowKeeper ? "allowed" : "off"}`);
  await program.methods
    .setGuardian(guardian.publicKey)
    .accountsPartial({ admin: payer.publicKey, config: configPda(), guardianState: guardianPda(), systemProgram: SystemProgram.programId })
    .rpc();
  log(`guardian: ${guardian.publicKey.toBase58()} (key in ${GUARDIAN_FILE})`);
}
