// End-to-end check of everything around the program (run after `pnpm smoke`, which covers borrow and lend):
//  - an Underwriter Pool deposit by a throwaway wallet (queued for the next epoch while one is open);
//  - the three relayers, the public API (health, markets, pools, positions, history) and the indexer;
//  - the web app's pages and its RPC proxy (an allowed call passes, a disallowed one is refused).
// Exits non-zero on the first failure. Usage: pnpm e2e   (API_URL, WEB_URL, RELAYER_URLS to point elsewhere)
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@anchor-lang/core";

import { DEVNET, MARKETS, configPda, epochPda, finityProgram, poolPda, poolSharesPda, poolTicketPda, toUnits, usdcVaultPda } from "../client/index";
import { log, setup } from "./env";

const API = process.env.API_URL ?? "http://127.0.0.1:8787";
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const RELAYERS = (process.env.RELAYER_URLS ?? "http://127.0.0.1:7701,http://127.0.0.1:7702,http://127.0.0.1:7703").split(",");

let failures = 0;
const check = (ok: boolean, what: string) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const getJson = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

// 1. Underwriter Pool deposit (XNYS) by a throwaway wallet.
const { payer, connection, provider } = setup();
const user = Keypair.generate();
await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL })));
const program = finityProgram(new AnchorProvider(connection, new Wallet(user), { commitment: "confirmed" }));
const usdcMint = new PublicKey(DEVNET.usdcMint);
const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, user.publicKey);
const common = { tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
await program.methods
  .faucet(toUnits(1_000))
  .accountsPartial({ user: user.publicKey, config: configPda(), mint: usdcMint, userToken: ownerUsdc, ...common, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID })
  .rpc();
const pool = poolPda("XNYS");
const p = await program.account.underwriterPool.fetch(pool);
const assets = toUnits(500);
if (p.epochActive) {
  const seq = Number(p.epochsOpened);
  await program.methods
    .poolDepositQueued(assets)
    .accountsPartial({
      owner: user.publicKey, config: configPda(), pool, epoch: epochPda(pool, seq), ticket: poolTicketPda(pool, user.publicKey, seq),
      ownerUsdc, usdcVault: usdcVaultPda(), ...common,
    })
    .rpc();
  const t = await program.account.poolTicket.fetch(poolTicketPda(pool, user.publicKey, seq));
  check(Number(t.depositAssets) === 500e6, `pool deposit queued into epoch #${seq} (500 USDC, shares minted at its settlement price)`);
} else {
  await program.methods
    .poolDeposit(assets)
    .accountsPartial({
      owner: user.publicKey, config: configPda(), pool, usdcMint, shareMint: poolSharesPda("XNYS"), ownerUsdc,
      ownerShares: getAssociatedTokenAddressSync(poolSharesPda("XNYS"), user.publicKey), usdcVault: usdcVaultPda(), ...common,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .rpc();
  const bal = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(poolSharesPda("XNYS"), user.publicKey));
  check(Number(bal.value.amount) > 0, "pool deposit minted shares at NAV (between epochs)");
}

// 2. Relayers.
for (const [i, base] of RELAYERS.entries()) {
  const r = await getJson(`${base}/v1/reports`).catch(() => ({ status: 0, body: null }));
  check(r.status === 200 && r.body?.reports?.length === MARKETS.length, `relayer ${i + 1} serves ${r.body?.reports?.length ?? 0} signed reports`);
}

// 3. Public API and indexer.
const h = await getJson(`${API}/v1/health`);
check(h.status === 200 && h.body?.ok === true, `api health (keeper tx ${h.body?.keeper?.lastTransactionAgeSecs}s ago, indexer lag ${h.body?.indexer?.lagSecs}s)`);
const markets = await getJson(`${API}/v1/markets`);
check(Array.isArray(markets.body) && markets.body.length === MARKETS.length && markets.body.every((m: any) => m.price > 0), `api lists ${markets.body?.length} markets with prices`);
const pools = await getJson(`${API}/v1/pools`);
check(pools.body?.length === 2, "api lists both pools");
const prices = await getJson(`${API}/v1/markets/AAPL/prices?limit=5`);
check(Array.isArray(prices.body) && prices.body.length > 0, `indexer has AAPL price history (${prices.body?.length} rows)`);
const txs = await getJson(`${API}/v1/transactions?limit=5`);
check(Array.isArray(txs.body) && txs.body.length > 0, "indexer has program transactions with instruction names");
const pos = await getJson(`${API}/v1/positions/${user.publicKey.toBase58()}`);
check(pos.status === 200 && Array.isArray(pos.body), "api positions route answers for a wallet");
const docs = await getJson(`${API}/v1/openapi.json`);
check(docs.body?.openapi === "3.1.0", "api serves its OpenAPI document");
const metrics = await fetch(`${API}/metrics`).then((r) => r.text());
check(metrics.includes("finity_up 1"), "prometheus metrics report finity_up 1");

// 4. Web app.
for (const path of ["/", "/app/markets", "/app/borrow", "/app/lend", "/app/underwrite", "/app/auctions", "/app/risk", "/app/alerts", "/app/settings", "/app/faucet"]) {
  const s = (await fetch(`${WEB}${path}`)).status;
  check(s === 200, `web ${path} → ${s}`);
}
const rpc = async (method: string) =>
  (await fetch(`${WEB}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) })).json() as Promise<any>;
check(typeof (await rpc("getSlot")).result === "number", "web RPC proxy forwards getSlot");
check(!!(await rpc("requestAirdrop")).error, "web RPC proxy refuses methods outside its allowlist");
const me = await getJson(`${WEB}/api/channels`);
check(me.status === 401, "notification settings need Sign-In With Solana");

log(failures ? `E2E FAILED (${failures})` : "E2E OK");
process.exit(failures ? 1 : 0);
