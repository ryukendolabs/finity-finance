import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { AnchorProvider, Wallet } from "@anchor-lang/core";
import { Connection, Keypair } from "@solana/web3.js";

import { finityProgram } from "../client/index";

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export function loadKeypair(path = process.env.SOLANA_WALLET ?? `${homedir()}/.config/solana/id.json`): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

export function setup() {
  const payer = loadKeypair();
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  return { payer, connection, provider, program: finityProgram(provider) };
}

export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
