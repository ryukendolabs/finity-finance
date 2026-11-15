// Hands Finity's admin role and the program's upgrade authority to a Squads v4 multisig vault.
//
//   MEMBERS=<pubkey>,<pubkey>,… THRESHOLD=2 pnpm handover            dry run: prints the plan, changes nothing
//   MEMBERS=… THRESHOLD=2 pnpm handover --execute                     does it
//   SQUADS_MULTISIG=<multisig pda> pnpm handover --execute            reuse an existing multisig
//
// Steps: (1) create the multisig (members with every permission, no time lock; the create key is kept in
// ~/.config/finity/squads-create-key.json so a rerun finds the same multisig), (2) set_admin(vault),
// (3) `solana program set-upgrade-authority` to the vault. The keeper and guardian keys stay as they are: the
// keeper's cranks are permissionless and the guardian has to act fast. After this, admin instructions (loaders,
// set_* calls) and program upgrades go through Squads proposals; the local admin key can no longer make them.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import * as multisig from "@sqds/multisig";
import { Keypair, PublicKey } from "@solana/web3.js";

import { PROGRAM_ID, configPda } from "../client/index";
import { RPC_URL, log, setup } from "./env";

const execute = process.argv.includes("--execute");
const { payer, connection, program } = setup();
const config = await program.account.config.fetch(configPda());

const members = (process.env.MEMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => new PublicKey(s));
if (!process.env.SQUADS_MULTISIG && members.length === 0) throw new Error("set MEMBERS=<pubkey>,<pubkey>,… (or SQUADS_MULTISIG to reuse one)");
const threshold = Number(process.env.THRESHOLD ?? Math.ceil(members.length / 2));
if (members.length && (threshold < 1 || threshold > members.length)) throw new Error(`THRESHOLD must be 1..${members.length}`);

const keyFile = `${homedir()}/.config/finity/squads-create-key.json`;
let multisigPda: PublicKey;
let createKey: Keypair | null = null;
if (process.env.SQUADS_MULTISIG) {
  multisigPda = new PublicKey(process.env.SQUADS_MULTISIG);
} else {
  createKey = existsSync(keyFile)
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8")) as number[]))
    : Keypair.generate();
  [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
}
const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
const exists = (await connection.getAccountInfo(multisigPda)) !== null;

log(execute ? "EXECUTING handover" : "DRY RUN (add --execute to perform it)");
log("program            ", PROGRAM_ID.toBase58());
log("current admin      ", config.admin.toBase58(), config.admin.equals(payer.publicKey) ? "(this wallet)" : "(NOT this wallet: set_admin will fail)");
log("multisig           ", multisigPda.toBase58(), exists ? "(exists)" : "(to create)");
if (!exists) log("members / threshold", members.map((m) => m.toBase58().slice(0, 6)).join(", "), `/ ${threshold}`);
log("new admin = vault  ", vault.toBase58());
log("upgrade authority  ", `${payer.publicKey.toBase58()} → ${vault.toBase58()}`);
if (!execute) process.exit(0);

if (!config.admin.equals(payer.publicKey)) throw new Error("this wallet is not the current admin");
if (!exists) {
  if (!createKey) throw new Error(`multisig ${multisigPda.toBase58()} not found`);
  writeFileSync(keyFile, JSON.stringify(Array.from(createKey.secretKey)), { mode: 0o600 });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const { treasury } = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  const sig = await multisig.rpc.multisigCreateV2({
    connection, treasury, createKey, creator: payer, multisigPda, configAuthority: null, threshold,
    members: members.map((key) => ({ key, permissions: multisig.types.Permissions.all() })), timeLock: 0, rentCollector: null,
    sendOptions: { skipPreflight: false },
  });
  await connection.confirmTransaction(sig, "confirmed");
  log("multisig created", sig);
}
const sig = await program.methods.setAdmin(vault).accountsPartial({ admin: payer.publicKey, config: configPda() }).rpc();
log("admin → vault", sig);
const out = execFileSync(
  "solana",
  ["program", "set-upgrade-authority", PROGRAM_ID.toBase58(), "--new-upgrade-authority", vault.toBase58(), "--skip-new-upgrade-authority-signer-check", "--url", RPC_URL],
  { encoding: "utf8" },
);
log("upgrade authority → vault", out.trim());
log("done: admin calls and upgrades now need", threshold, "of", members.length || "the multisig's", "approvals in Squads");
