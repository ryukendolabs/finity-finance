// One price relayer node, run as its own process with its own key (k of n of them make a price; the program
// checks every signature). It reads quotes independently, signs "FNTY" ‖ market ‖ price ‖ observed_at with its
// Ed25519 key, and serves its latest signed report per market over HTTP for the keeper to collect:
//
//   GET /v1/reports  →  { signer, reports: [{ symbol, market, price, observedAt, signature }] }   (base-10 / base64)
//   GET /health      →  { ok, signer, lastFetch }
//
// Usage: RELAYER_INDEX=1 pnpm relayer   (key ~/.config/finity/relayer-1.json, port 7701; index 2 → 7702, …)
// The node never sends transactions and holds no SOL: a keeper can only forward what it signed.
import { createPrivateKey, sign } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { Keypair, PublicKey } from "@solana/web3.js";

import { DEVNET, MARKETS, marketPda, priceReport, toUnits } from "../client/index";
import { fetchQuote } from "./quotes";
import { log } from "./env";

const INDEX = Number(process.env.RELAYER_INDEX ?? 1);
const PORT = Number(process.env.RELAYER_PORT ?? 7700 + INDEX);
const HOST = process.env.RELAYER_HOST ?? "127.0.0.1";
const REFRESH_SECS = Number(process.env.RELAYER_REFRESH_SECS ?? 15);
const keyPath = process.env.RELAYER_KEY ?? `${homedir()}/.config/finity/relayer-${INDEX}.json`;
const node = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")) as number[]));
// The Ed25519 seed is the first 32 bytes of Solana's 64-byte keypair; Node's crypto takes it as PKCS#8.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const secret = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(node.secretKey.slice(0, 32))]), format: "der", type: "pkcs8" });

type Signed = { symbol: string; market: string; price: string; observedAt: number; signature: string };
const latest = new Map<string, Signed>();
let lastFetch = 0;

async function refresh() {
  const now = Math.floor(Date.now() / 1000);
  for (const spec of MARKETS) {
    const mint = DEVNET.mints[spec.symbol];
    if (!mint) continue;
    try {
      const q = await fetchQuote(spec.quote);
      const market = marketPda(new PublicKey(mint));
      const price = BigInt(toUnits(q.price).toString());
      const signature = sign(null, priceReport(market, price, now), secret);
      latest.set(spec.symbol, {
        symbol: spec.symbol, market: market.toBase58(), price: price.toString(), observedAt: now,
        signature: Buffer.from(signature).toString("base64"),
      });
    } catch (e) {
      log(`relayer ${INDEX}: ${spec.symbol}: ${(e as Error).message}`);
    }
  }
  lastFetch = now;
}

const server = createServer((req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return send(405, { error: "GET only" });
  if (req.url === "/v1/reports") return send(200, { signer: node.publicKey.toBase58(), reports: [...latest.values()] });
  if (req.url === "/health") return send(200, { ok: Date.now() / 1000 - lastFetch < REFRESH_SECS * 4, signer: node.publicKey.toBase58(), lastFetch });
  send(404, { error: "not found" });
});

await refresh();
setInterval(() => void refresh(), REFRESH_SECS * 1000);
server.listen(PORT, HOST, () => log(`relayer ${INDEX} (${node.publicKey.toBase58()}) serving signed reports on http://${HOST}:${PORT}`));
