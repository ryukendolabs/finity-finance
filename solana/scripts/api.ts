// The public API: read-only JSON over live chain state (markets, clocks, pools, auctions, positions) and the
// indexer's history (prices, clock transitions, transactions), plus health and Prometheus metrics.
//   http://127.0.0.1:8787/v1/openapi.json describes every route.
// Holds no keys and sends nothing. Usage: pnpm api   (PORT / API_HOST to change where it listens)
import { serve } from "@hono/node-server";
import { PublicKey } from "@solana/web3.js";
import { Hono } from "hono";
import { cors } from "hono/cors";

import {
  AUCTION_KIND_NAME,
  CLOSURE_NAMES,
  PROGRAM_ID,
  clockPda,
  clockStateName,
  fetchMarkets,
  fetchPositions,
  fromUnits,
  poolFreeCash,
  poolNav,
  poolPda,
  positionHealth,
  venueOf,
} from "../client/index";
import { log, setup } from "./env";
import { INDEX_DB, openIndex } from "./indexer";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.API_HOST ?? "127.0.0.1";
const { connection, program, payer } = setup();
const db = openIndex();
const app = new Hono();
app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET"] }));

const q = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
const clampLimit = (v: string | undefined, d = 100) => Math.max(1, Math.min(1000, Number(v ?? d) || d));
/** Short in-process cache so a burst of requests costs one RPC round. */
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, secs: number, f: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < secs * 1000) return hit.v as T;
  const v = await f();
  cache.set(key, { at: Date.now(), v });
  return v;
}

async function marketsView() {
  return cached("markets", 10, async () => {
    const list = await fetchMarkets(program);
    const clocks = await program.account.assetClock.fetchMultiple(list.map((m) => clockPda(m.publicKey)));
    const now = Math.floor(Date.now() / 1000);
    return list.map(({ publicKey, account: m }, i) => {
      const c = clocks[i];
      return {
        symbol: m.symbol,
        market: publicKey.toBase58(),
        mint: m.collateralMint.toBase58(),
        venue: venueOf(m.symbol),
        price: fromUnits(m.price),
        priceAgeSecs: now - Number(m.priceUpdatedAt),
        state: c ? clockStateName(c.state) : null,
        closure: c ? { id: Number(c.closureId), type: CLOSURE_NAMES[c.closureType] ?? String(c.closureType), nextCloseAt: Number(c.nextCloseAt), nextReopenAt: Number(c.nextReopenAt) } : null,
        maxLtv: m.maxLtvBps / 1e4,
        closedLtv: m.closedLtvBps / 1e4,
        liquidationThreshold: m.liqThresholdBps / 1e4,
        supplied: fromUnits(m.totalSupplyAssets),
        borrowed: fromUnits(m.totalBorrowAssets),
        collateral: fromUnits(m.totalCollateral, m.collateralDecimals),
      };
    });
  });
}

async function poolsView() {
  return cached("pools", 15, async () => {
    const out = [];
    for (const venue of ["XNYS", "USBANK"]) {
      const p = await program.account.underwriterPool.fetchNullable(poolPda(venue));
      if (!p) continue;
      out.push({
        venue, pool: poolPda(venue).toBase58(), nav: Number(poolNav(p)) / 1e6, freeCash: Number(poolFreeCash(p)) / 1e6,
        inventoryMark: fromUnits(p.inventoryMark), redemptionClaims: fromUnits(p.claimsCost), unearnedPremiums: fromUnits(p.unearnedPremiums),
        lossesPaid: fromUnits(p.lossesPaid), epochActive: p.epochActive, epochsOpened: Number(p.epochsOpened),
      });
    }
    return out;
  });
}

app.get("/", (c) => c.json({ name: "Finity Finance API", network: "solana-devnet", program: PROGRAM_ID.toBase58(), docs: "/v1/openapi.json" }));
app.get("/v1/markets", async (c) => c.json(await marketsView()));
app.get("/v1/markets/:symbol", async (c) => {
  const m = (await marketsView()).find((x) => x.symbol === c.req.param("symbol").toUpperCase());
  return m ? c.json(m) : c.json({ error: "unknown market" }, 404);
});
app.get("/v1/markets/:symbol/prices", (c) => {
  const from = Number(c.req.query("from") ?? 0);
  const to = Number(c.req.query("to") ?? 2 ** 40);
  return c.json(q("select price, at from prices where symbol = ? and at between ? and ? order by at desc limit ?", c.req.param("symbol").toUpperCase(), from, to, clampLimit(c.req.query("limit"), 500)));
});
app.get("/v1/markets/:symbol/clock", (c) =>
  c.json(q("select state, closure_id as closureId, at from clock_states where symbol = ? order by at desc limit ?", c.req.param("symbol").toUpperCase(), clampLimit(c.req.query("limit")))),
);
app.get("/v1/pools", async (c) => c.json(await poolsView()));
app.get("/v1/pools/:venue/history", (c) =>
  c.json(
    q(
      "select at, nav, free_cash as freeCash, inventory_mark as inventoryMark, claims_cost as redemptionClaims, losses_paid as lossesPaid from pools where venue = ? order by at desc limit ?",
      c.req.param("venue").toUpperCase(), clampLimit(c.req.query("limit"), 288),
    ),
  ),
);
app.get("/v1/auctions", (c) => {
  const symbol = c.req.query("symbol")?.toUpperCase();
  const rows = symbol
    ? q("select * from auctions where symbol = ? order by clear_at desc limit ?", symbol, clampLimit(c.req.query("limit")))
    : q("select * from auctions order by clear_at desc limit ?", clampLimit(c.req.query("limit")));
  return c.json(rows);
});
app.get("/v1/positions/:owner", async (c) => {
  let owner: PublicKey;
  try {
    owner = new PublicKey(c.req.param("owner"));
  } catch {
    return c.json({ error: "not a Solana address" }, 400);
  }
  const [markets, positions] = await Promise.all([fetchMarkets(program), fetchPositions(program, owner)]);
  const now = Math.floor(Date.now() / 1000);
  return c.json(
    positions.flatMap(({ publicKey, account: p }) => {
      const m = markets.find((x) => x.publicKey.equals(p.market));
      if (!m) return [];
      const h = positionHealth(m.account, p, now);
      return [{
        position: publicKey.toBase58(), symbol: m.account.symbol, collateral: fromUnits(p.collateral, m.account.collateralDecimals),
        collateralValue: h.value, debt: h.debt, ltv: h.value ? h.debt / h.value : null, healthFactor: h.debt ? h.liqLimit / h.debt : null, liquidatable: h.liquidatable,
      }];
    }),
  );
});
app.get("/v1/transactions", (c) =>
  c.json(q("select signature, slot, block_time as blockTime, ixs as instructions, err from txs order by slot desc limit ?", clampLimit(c.req.query("limit"), 50))),
);

/** Health: the keeper's balance and last transaction, price freshness, the indexer's lag, relayers' status. */
async function health() {
  const now = Math.floor(Date.now() / 1000);
  const [markets, balance] = await Promise.all([marketsView(), connection.getBalance(payer.publicKey)]);
  const indexedAt = Number((db.prepare("select v from meta where k = 'indexed_at'").get() as { v: string } | undefined)?.v ?? 0);
  const lastTx = (db.prepare("select block_time from txs order by slot desc limit 1").get() as { block_time: number } | undefined)?.block_time ?? 0;
  const relayers = await Promise.all(
    (process.env.RELAYER_URLS ?? "").split(",").filter(Boolean).map(async (u) => {
      try {
        const r = (await (await fetch(`${u}/health`, { signal: AbortSignal.timeout(3_000) })).json()) as { ok: boolean; signer: string };
        return { url: u, ok: r.ok, signer: r.signer };
      } catch {
        return { url: u, ok: false, signer: null };
      }
    }),
  );
  const stalest = Math.max(0, ...markets.map((m) => m.priceAgeSecs));
  return {
    ok: now - indexedAt < 120 && now - lastTx < 900 && relayers.every((r) => r.ok),
    keeper: { address: payer.publicKey.toBase58(), sol: balance / 1e9, lastTransactionAgeSecs: lastTx ? now - lastTx : null },
    prices: { stalestAgeSecs: stalest },
    indexer: { db: INDEX_DB, lagSecs: indexedAt ? now - indexedAt : null },
    relayers,
  };
}
app.get("/v1/health", async (c) => {
  const h = await health();
  return c.json(h, h.ok ? 200 : 503);
});

/** Prometheus text format. */
app.get("/metrics", async (c) => {
  const [h, markets, pools] = await Promise.all([health(), marketsView(), poolsView()]);
  const lines = [
    "# HELP finity_up 1 when keeper, indexer and relayers are all healthy.",
    "# TYPE finity_up gauge",
    `finity_up ${h.ok ? 1 : 0}`,
    "# TYPE finity_keeper_sol gauge",
    `finity_keeper_sol ${h.keeper.sol}`,
    "# TYPE finity_keeper_last_tx_age_seconds gauge",
    `finity_keeper_last_tx_age_seconds ${h.keeper.lastTransactionAgeSecs ?? -1}`,
    "# TYPE finity_indexer_lag_seconds gauge",
    `finity_indexer_lag_seconds ${h.indexer.lagSecs ?? -1}`,
    "# TYPE finity_relayer_up gauge",
    ...h.relayers.map((r, i) => `finity_relayer_up{relayer="${i + 1}"} ${r.ok ? 1 : 0}`),
    "# TYPE finity_price gauge",
    ...markets.map((m) => `finity_price{symbol="${m.symbol}"} ${m.price}`),
    "# TYPE finity_price_age_seconds gauge",
    ...markets.map((m) => `finity_price_age_seconds{symbol="${m.symbol}"} ${m.priceAgeSecs}`),
    "# TYPE finity_market_borrowed_usdc gauge",
    ...markets.map((m) => `finity_market_borrowed_usdc{symbol="${m.symbol}"} ${m.borrowed}`),
    "# TYPE finity_pool_nav_usdc gauge",
    ...pools.map((p) => `finity_pool_nav_usdc{venue="${p.venue}"} ${p.nav}`),
    "# TYPE finity_pool_inventory_usdc gauge",
    ...pools.map((p) => `finity_pool_inventory_usdc{venue="${p.venue}"} ${p.inventoryMark + p.redemptionClaims}`),
  ];
  return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/plain; version=0.0.4" });
});

const routes: [string, string, string][] = [
  ["/v1/markets", "Every market: price, clock state, LTV limits, supply and borrow.", "Market[]"],
  ["/v1/markets/{symbol}", "One market.", "Market"],
  ["/v1/markets/{symbol}/prices", "Price history (query: from, to, limit).", "PricePoint[]"],
  ["/v1/markets/{symbol}/clock", "Market-clock transitions, newest first.", "ClockTransition[]"],
  ["/v1/pools", "Underwriter Pools: NAV, free cash, auction inventory, redemption claims.", "Pool[]"],
  ["/v1/pools/{venue}/history", "NAV snapshots every 5 minutes.", "PoolSnapshot[]"],
  ["/v1/auctions", "Liquidation auctions, newest first (query: symbol, limit).", "Auction[]"],
  ["/v1/positions/{owner}", "A wallet's loans with value, debt and health.", "Position[]"],
  ["/v1/transactions", "Program transactions with their instruction names.", "Transaction[]"],
  ["/v1/health", "Keeper, prices, indexer and relayers (503 when unhealthy).", "Health"],
];
app.get("/v1/openapi.json", (c) =>
  c.json({
    openapi: "3.1.0",
    info: { title: "Finity Finance API", version: "1.0.0", description: `Read-only. Solana devnet, program ${PROGRAM_ID.toBase58()}. Amounts in USDC or whole tokens; times in unix seconds.` },
    servers: [{ url: `http://${HOST}:${PORT}` }],
    paths: Object.fromEntries(
      routes.map(([path, summary, schema]) => [
        path,
        {
          get: {
            summary,
            parameters: [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } })),
            responses: { "200": { description: schema, content: { "application/json": { schema: { type: schema.endsWith("[]") ? "array" : "object" } } } } },
          },
        },
      ]),
    ),
  }),
);
app.notFound((c) => c.json({ error: "not found", docs: "/v1/openapi.json" }, 404));
app.onError((e, c) => {
  log("api error:", e.message);
  return c.json({ error: "internal error" }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => log(`api on http://${HOST}:${PORT} (docs /v1/openapi.json, kind names: ${Object.values(AUCTION_KIND_NAME).join("/")})`));
