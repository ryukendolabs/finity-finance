// Loads the calibrated market clock and risk data on-chain (idempotent):
//  - venue calendars XNYS (stocks) and USBANK (the T-Bill fund) from data/calibration/calendars
//  - risk parameters, and per market × closure type: σ, σ floor, scenario hash and the lowest 256 scenarios,
//    from the published risk bundles (data/calibration/risk-bundle-*.json, nav/risk-bundle-nav-*.json)
//  - one clock per market
import { readFileSync, readdirSync } from "node:fs";

import { PublicKey, SystemProgram } from "@solana/web3.js";

import {
  BN,
  CLOSURE,
  DEVNET,
  MARKETS,
  calendarPda,
  clockPda,
  configPda,
  marketPda,
  riskConfigPda,
  riskSetPda,
  venueBytes,
} from "../client/index";
import { log, setup } from "./env";

const CAL = new URL("../data/calibration/", import.meta.url);
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, CAL), "utf8"));
const Z_TAIL = 256;
const CHUNK = 40;

const { payer, connection, program } = setup();
const config = configPda();
const exists = async (k: PublicKey) => (await connection.getAccountInfo(k)) !== null;
if (!DEVNET.usdcMint) throw new Error("client/devnet.json is empty: run `pnpm seed` first");

// ── calendars ──
const calendarFile = (venue: string) => readdirSync(new URL("calendars/", CAL)).find((f) => f.startsWith(`${venue}-`))!;
for (const venue of ["XNYS", "USBANK"] as const) {
  const file = read(`calendars/${calendarFile(venue)}`);
  const calendar = calendarPda(venue);
  if (!(await exists(calendar))) {
    await program.methods.initCalendar(Array.from(venueBytes(venue))).accountsPartial({ admin: payer.publicKey, config, calendar, systemProgram: SystemProgram.programId }).rpc();
    log(venue, "calendar created");
  }
  const have = (await program.account.calendar.fetch(calendar)).len;
  const sessions = (file.sessions as { extOpen: number; open: number; close: number; extClose: number; closureTypeAfter: number }[]).map((s) => ({
    extOpen: s.extOpen, open: s.open, close: s.close, extClose: s.extClose, closureTypeAfter: s.closureTypeAfter,
  }));
  for (let i = have; i < sessions.length; i += CHUNK) {
    await program.methods.appendSessions(sessions.slice(i, i + CHUNK)).accountsPartial({ admin: payer.publicKey, config, calendar }).rpc();
    log(venue, `sessions ${i}..${Math.min(i + CHUNK, sessions.length) - 1}`);
  }
  log(venue, `${sessions.length} sessions (${file.from} → ${file.to}), hash ${file.contentHash.slice(0, 10)}…`);
}

// ── risk parameters (identical in both bundles) ──
const equity = read("risk-bundle-cfbb86cb.json");
const nav = read("nav/risk-bundle-nav-5bdf292d.json");
const P = equity.params;
const n = (x: string | number) => new BN(String(x));
await program.methods
  .setRiskConfig(
    {
      alpha: n(P.alpha), beta: n(P.beta), kappa: n(P.kappa), theta: n(P.theta), costOfCap: n(P.costOfCap),
      eta: n(P.eta), minPremium: n(P.minPremium), uMax: n(P.uMax), kStress: P.kStress,
    },
    new PublicKey(process.env.SIGMA_ORACLE ?? payer.publicKey.toBase58()),
  )
  .accountsPartial({ admin: payer.publicKey, config, riskConfig: riskConfigPda(), systemProgram: SystemProgram.programId })
  .rpc();
log("risk config set: α", P.alpha, "κ", P.kappa, "β", P.beta);

// ── per-market risk sets and clocks ──
type Bundle = { scenarioSets: string[]; sigmas: { assetIds: string[]; closureTypes: number[]; values: string[] }; sigmaFloors: { assetIds: string[]; closureTypes: number[]; floors: string[] } };
const pick = (b: Bundle, assetId: string, t: number, which: "sigmas" | "sigmaFloors") => {
  const x = b[which];
  const i = x.assetIds.findIndex((a, j) => a === assetId && x.closureTypes[j] === t);
  return i < 0 ? null : which === "sigmas" ? (x as Bundle["sigmas"]).values[i]! : (x as Bundle["sigmaFloors"]).floors[i]!;
};

for (const spec of MARKETS) {
  const mint = new PublicKey(DEVNET.mints[spec.symbol]!);
  const market = marketPda(mint);
  const isNav = spec.venue === "USBANK";
  const bundle: Bundle = isNav ? nav : equity;
  const dir = isNav ? "nav/" : "";

  for (const t of [CLOSURE.OVERNIGHT, CLOSURE.WEEKEND, CLOSURE.HOLIDAY_WEEKEND]) {
    const file = bundle.scenarioSets.find((f) => f.split("/").pop()!.startsWith(`${spec.symbol}-`) && f.includes(`-${t}-`));
    if (!file) throw new Error(`${spec.symbol}: no scenario set for closure type ${t}`);
    const set = read(dir + (isNav ? file.split("/").pop()! : file));
    const sigma = pick(bundle, set.assetId, t, "sigmas");
    const floor = pick(bundle, set.assetId, t, "sigmaFloors");
    if (!sigma || !floor) throw new Error(`${spec.symbol}/${t}: σ or floor missing in the bundle`);
    const riskSet = riskSetPda(market, t);
    const hash = Array.from(Buffer.from(set.scenarioHash.slice(2), "hex"));
    const current = (await exists(riskSet)) ? await program.account.riskSet.fetch(riskSet) : null;
    if (current && Buffer.from(current.scenarioHash).equals(Buffer.from(hash))) continue;
    await program.methods
      .setScenarioSet(t, set.n, hash, (set.z as number[]).slice(0, Z_TAIL), n(sigma), n(floor))
      .accountsPartial({ admin: payer.publicKey, config, market, riskSet, systemProgram: SystemProgram.programId })
      .rpc();
    log(spec.symbol, `type ${t}: n=${set.n} σ=${Number(sigma) / 1e18} floor=${Number(floor) / 1e18} z[${Z_TAIL}] hash ${set.scenarioHash.slice(0, 10)}…`);
  }

  const clock = clockPda(market);
  if (!(await exists(clock))) {
    await program.methods
      .initClock()
      .accountsPartial({ admin: payer.publicKey, config, market, calendar: calendarPda(spec.venue), clock, systemProgram: SystemProgram.programId })
      .rpc();
  }
  const c = await program.account.assetClock.fetch(clock);
  log(spec.symbol, `clock ${Object.keys(c.state)[0]}, next close ${new Date(Number(c.nextCloseAt) * 1000).toISOString()}`);
}
log("risk and clocks loaded");
