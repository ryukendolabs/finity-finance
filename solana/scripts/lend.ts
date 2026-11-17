// Finity Lend operations: create the test tokens and markets, run the price keeper, show status, rehearse, tear down.
//
//   pnpm lend seed      [--cluster mainnet|devnet]            markets and vaults (pays rent). Mainnet: the real xStocks
//                                                             and USDC, checked on-chain; devnet: Token-2022 test mints
//   pnpm lend keeper    [--cluster mainnet|devnet] [--once]   posts the 7 prices in one transaction while markets are open
//                       (--force, devnet only: post the fresh prices whatever the hours, for rehearsals)
//   pnpm lend status    [--cluster mainnet|devnet]
//   pnpm lend fund      --cluster devnet --amount <USD>       mints test USD into the loan vault (devnet only; on mainnet
//                                                             the lender supplies USDC from the Lend page)
//   pnpm lend faucet    --cluster devnet --to <wallet> [--symbol AAPLx] [--amount 10]   test tokens (devnet only)
//   pnpm lend demo      [--cluster devnet]                    faucet, borrow, repay, close with the authority's wallet
//   pnpm lend teardown  [--cluster …]                         after `deploy.sh <cluster> --teardown`: everything back
//
// Keys (never in the repo, ~/.config/finity, mode 600):
//   mainnet-authority.json   payer, upgrade authority, markets authority and keeper (LEND_WALLET overrides; devnet
//                            defaults to SOLANA_WALLET or ~/.config/solana/id.json)
//   lend-faucet.json         mint authority of the devnet test tokens (LEND_FAUCET_WALLET overrides)
// Settings (env, or ~/.config/finity/env via the service unit):
//   LEND_RPC_URL        RPC for the Lend cluster (default: the cluster's public endpoint)
//   SOLANA_RPC_URL      devnet RPC the keeper reads prices and market hours from (the full program)
//   LEND_TICK_SECS      how often the keeper reads devnet (default 60; reads are free)
//   LEND_PRICE_SECS     how often prices are posted while a market is open (default 900; the program accepts ≤ 1200 s)
//   LEND_EXTENDED       1 = also post during extended hours (more fees); default regular hours only
//   LEND_MIN_BALANCE    the keeper stops writing below this many SOL (default 0.0008: a fee payer must stay above the
//                       0.00065 SOL rent-exempt minimum)
//   LEND_FUND_USD       devnet: test USD minted into the loan vault by `seed` (default 1,000,000)
//   LEND_LENDER         the lender's wallet: the loan money in the vault is its capital, `fund --lender` mints test USD
//                       to it, and `teardown` returns what is left of the pool to it. Kept out of the repo and the app.

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { MARKETS, clockPda, clockStateName, fetchMarkets } from "../client/index";
import {
  LEND,
  LEND_DECIMALS,
  LEND_PROGRAM_ID,
  MARKETS_LEN,
  POSITION_LEN,
  ataOf,
  createProgramAccountIx,
  decodeMarkets,
  fetchPositions,
  lendAddresses,
  lendErrorText,
  lendIx,
  type LendAddresses,
  type LendCluster,
  type LendDeployment,
  fromPostedPrice,
  maxLoan,
  toPostedPrice,
  tokenProgramId,
  vaultAuthority,
  vaultFor,
} from "../client/lend";
import { loadKeypair, log, setup } from "./env";

const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cluster = (opt("cluster") ?? "mainnet") as LendCluster;
if (cluster !== "mainnet" && cluster !== "devnet") throw new Error("--cluster must be mainnet or devnet");

const RPC =
  process.env.LEND_RPC_URL ||
  (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const WALLET =
  process.env.LEND_WALLET ||
  (cluster === "mainnet" ? `${homedir()}/.config/finity/mainnet-authority.json` : process.env.SOLANA_WALLET || `${homedir()}/.config/solana/id.json`);
const FAUCET_WALLET = process.env.LEND_FAUCET_WALLET || `${homedir()}/.config/finity/lend-faucet.json`;
const TICK_SECS = Number(process.env.LEND_TICK_SECS ?? 60);
const PRICE_SECS = Number(process.env.LEND_PRICE_SECS ?? 900);
const EXTENDED = process.env.LEND_EXTENDED === "1";
/** Rehearsal only (devnet): `keeper --force` posts the source prices whatever the market hours and their age. */
const FORCE = args.includes("--force");
if (FORCE && cluster !== "devnet") throw new Error("--force is for devnet rehearsals only");
const MIN_BALANCE = Number(process.env.LEND_MIN_BALANCE ?? 0.0008);
const FUND_USD = BigInt(process.env.LEND_FUND_USD ?? 1_000_000);
const LENDER = process.env.LEND_LENDER?.trim() ? new PublicKey(process.env.LEND_LENDER.trim()) : null;
const requireLender = () => {
  if (!LENDER) throw new Error("LEND_LENDER (the lender's wallet) is not set in ~/.config/finity/env");
  return LENDER;
};
/** The keeper does not forward a devnet price older than this (the full program's own freshness bound). */
const SOURCE_MAX_AGE = 180;
/** Priority fee for setup transactions (micro-lamports per CU, with a tight CU limit: a few lamports each). */
const CU_PRICE = 1_000;

const ONE = 10n ** BigInt(LEND_DECIMALS);
const conn = new Connection(RPC, "confirmed");
const BOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "../client/lend.json");
const explorer = (a: string, kind = "address") => `https://explorer.solana.com/${kind}/${a}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
const usd = (n: bigint) => `$${(Number(n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function saveBook() {
  writeFileSync(BOOK_PATH, JSON.stringify(LEND, null, 2) + "\n");
}

async function send(ixs: TransactionInstruction[], signers: Keypair[], cuLimit?: number) {
  const tx = new Transaction();
  if (cuLimit) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }));
  tx.add(...ixs);
  try {
    return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  } catch (e) {
    const why = lendErrorText(e);
    throw why ? new Error(`${why} (${String((e as Error).message).split("\n")[0]})`) : e;
  }
}

const balance = async (pk: PublicKey) => (await conn.getBalance(pk)) / LAMPORTS_PER_SOL;
const tokenBalance = async (a: PublicKey) => {
  const info = await conn.getAccountInfo(a);
  return info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : null;
};

function requireAddresses(): LendAddresses {
  const a = lendAddresses(cluster);
  if (!a) throw new Error(`no Lend deployment on ${cluster}: run \`pnpm lend seed --cluster ${cluster}\` first`);
  return a;
}

async function requireProgram() {
  const program = await conn.getAccountInfo(LEND_PROGRAM_ID);
  if (!program?.executable) throw new Error(`Lend program ${LEND_PROGRAM_ID.toBase58()} is not deployed on ${cluster} (solana/lend/deploy.sh ${cluster})`);
}

// ───────────── seed ─────────────

/** The markets Lend lists, in program order: the full protocol's, with its closure-safe LTV as the limit (Lend has
 *  no liquidation, so it lends only what stays safe through a close). */
const LISTED = MARKETS.filter((m) => m.marketHours).map((m) => ({ symbol: `${m.symbol}x`, source: m.symbol, maxLtvBps: m.closedLtvBps }));
/** Mainnet tokens: USDC (SPL Token, 6 decimals) and the xStocks (Token-2022, 8 decimals). Checked on-chain by seed. */
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const XSTOCKS: Record<string, string> = {
  AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  AMZNx: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
  GOOGLx: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
  MSFTx: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
  NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  TSLAx: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
};
const STOCK_DECIMALS = 8;

/** Every mint in the book is owned by the expected token program and has the expected decimals. */
async function checkMints(dep: LendDeployment) {
  const all = [{ symbol: "loan", mint: dep.usdMint, decimals: LEND_DECIMALS, program: "spl" as const }, ...dep.mints];
  const infos = await conn.getMultipleAccountsInfo(all.map((m) => new PublicKey(m.mint)));
  const bad = all.flatMap((m, i) => {
    const d = infos[i];
    if (!d) return [`${m.symbol}: mint ${m.mint} not found`];
    if (!d.owner.equals(tokenProgramId(m.program))) return [`${m.symbol}: owned by ${d.owner.toBase58()}, expected ${tokenProgramId(m.program).toBase58()}`];
    if (d.data[44] !== m.decimals) return [`${m.symbol}: ${d.data[44]} decimals, expected ${m.decimals}`];
    return [];
  });
  if (bad.length) throw new Error(`mint check failed:\n  ${bad.join("\n  ")}`);
  log(`mints checked: loan token and ${dep.mints.length} collateral tokens`);
}

async function seed() {
  await requireProgram();
  const authority = loadKeypair(WALLET);
  const faucet = loadKeypair(FAUCET_WALLET);
  const start = await balance(authority.publicKey);
  log(`seeding Lend on ${cluster}; authority ${authority.publicKey.toBase58()} has ${start.toFixed(6)} SOL; mint authority ${faucet.publicKey.toBase58()}`);
  const mintRent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);

  // 1. Tokens. Mainnet: the real USDC and xStocks. Devnet: test mints shaped like them (test USD in SPL Token with 6
  //    decimals; stocks in Token-2022 with 8, no freeze authority), saved as they are created.
  const dep = (LEND.clusters[cluster] ??= { markets: "", usdMint: "", mints: [] });
  if (cluster === "mainnet") {
    dep.usdMint ||= MAINNET_USDC;
    for (const l of LISTED)
      if (!dep.mints.some((m) => m.symbol === l.symbol)) dep.mints.push({ symbol: l.symbol, mint: XSTOCKS[l.symbol]!, decimals: STOCK_DECIMALS, program: "2022" });
  } else {
    const want = [{ symbol: "USD", key: "usdMint" as const }, ...LISTED.map((m) => ({ symbol: m.symbol, key: null }))];
    const missing = want.filter((w) => (w.key ? !dep.usdMint : !dep.mints.some((m) => m.symbol === w.symbol)));
    for (let i = 0; i < missing.length; i += 3) {
      const batch = missing.slice(i, i + 3).map((w) => ({ ...w, kp: Keypair.generate() }));
      const ixs = batch.flatMap(({ kp, key }) => {
        const program = key ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
        return [
          SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: kp.publicKey, lamports: mintRent, space: MINT_SIZE, programId: program }),
          createInitializeMint2Instruction(kp.publicKey, key ? LEND_DECIMALS : STOCK_DECIMALS, faucet.publicKey, null, program),
        ];
      });
      const sig = await send(ixs, [authority, ...batch.map((b) => b.kp)], 30_000);
      for (const b of batch) {
        if (b.key) dep.usdMint = b.kp.publicKey.toBase58();
        else dep.mints.push({ symbol: b.symbol, mint: b.kp.publicKey.toBase58(), decimals: STOCK_DECIMALS, program: "2022" });
      }
      saveBook();
      log(`mints ${batch.map((b) => `${b.symbol} ${b.kp.publicKey.toBase58()}`).join(", ")} ${explorer(sig, "tx")}`);
    }
  }
  await checkMints(dep);
  // Market order follows LISTED.
  dep.mints.sort((x, y) => LISTED.findIndex((m) => m.symbol === x.symbol) - LISTED.findIndex((m) => m.symbol === y.symbol));
  saveBook();

  // 2. The markets account, initialised in the same transaction (its keypair is used once and discarded).
  if (!dep.markets) {
    const kp = Keypair.generate();
    const [pda, bump] = vaultAuthority(kp.publicKey);
    const loanVault = vaultFor(kp.publicKey, new PublicKey(dep.usdMint));
    const sig = await send(
      [
        lendIx.ensureAta(authority.publicKey, pda, new PublicKey(dep.usdMint)),
        await createProgramAccountIx(conn, authority.publicKey, kp.publicKey, MARKETS_LEN),
        lendIx.init(kp.publicKey, authority.publicKey, loanVault, bump),
      ],
      [authority, kp],
      60_000,
    );
    dep.markets = kp.publicKey.toBase58();
    saveBook();
    log(`markets ${dep.markets} (vault authority ${pda.toBase58()}, loan vault ${loanVault.toBase58()}) ${explorer(sig, "tx")}`);
  }

  // 3. Collateral vaults and markets, in market order (add_market appends, so skip those already listed).
  const a = requireAddresses();
  const listed = decodeMarkets((await conn.getAccountInfo(a.markets))!.data)!;
  const todo = a.mints.slice(listed.markets.length);
  for (let i = 0; i < todo.length; i += 4) {
    const batch = todo.slice(i, i + 4);
    const ixs = batch.flatMap((m) => [
      lendIx.ensureAta(authority.publicKey, a.vaultAuthority, m.mint, m.tokenProgram),
      lendIx.addMarket(a.markets, authority.publicKey, m.vault, m.symbol, LISTED.find((l) => l.symbol === m.symbol)!.maxLtvBps),
    ]);
    const sig = await send(ixs, [authority], 50_000 * batch.length);
    log(`listed ${batch.map((m) => m.symbol).join(", ")} ${explorer(sig, "tx")}`);
  }

  // 4. Check off-chain what the program trusts the authority for: each vault is a token account of the right mint,
  //    owned by the vault authority, and registered at the right index.
  await verify(a);

  // 5. Loan money. Mainnet: the lender supplies USDC from the Lend page. Devnet: test USD minted into the loan vault.
  if (cluster === "mainnet") log("the pool is empty until the lender supplies USDC (Lend page, from the lender's wallet)");
  else if ((await tokenBalance(a.loanVault)) === 0n && FUND_USD > 0n) {
    const sig = await send([createMintToInstruction(a.usdMint, a.loanVault, faucet.publicKey, FUND_USD * ONE)], [authority, faucet], 20_000);
    log(`loan vault funded with ${usd(FUND_USD * ONE)} test USD ${explorer(sig, "tx")}`);
  }
  const end = await balance(authority.publicKey);
  log(`done: spent ${(start - end).toFixed(6)} SOL, ${end.toFixed(6)} SOL left. Address book: client/lend.json (commit it).`);
}

async function verify(a: LendAddresses) {
  const m = decodeMarkets((await conn.getAccountInfo(a.markets))!.data);
  if (!m) throw new Error("markets account unreadable");
  const [, bump] = vaultAuthority(a.markets);
  const problems: string[] = [];
  if (m.bump !== bump) problems.push(`bump ${m.bump}, expected ${bump}`);
  if (!m.loanVault.equals(a.loanVault)) problems.push(`loan vault ${m.loanVault.toBase58()}, expected ${a.loanVault.toBase58()}`);
  const vaults = [{ symbol: "loan", mint: a.usdMint, vault: a.loanVault, tokenProgram: TOKEN_PROGRAM_ID }, ...a.mints];
  const infos = await conn.getMultipleAccountsInfo(vaults.map((v) => v.vault));
  vaults.forEach((v, i) => {
    const d = infos[i];
    if (!d || !d.owner.equals(v.tokenProgram) || d.data.length < 165) return problems.push(`${v.symbol} vault missing`);
    if (!new PublicKey(d.data.subarray(0, 32)).equals(v.mint)) problems.push(`${v.symbol} vault has the wrong mint`);
    if (!new PublicKey(d.data.subarray(32, 64)).equals(a.vaultAuthority)) problems.push(`${v.symbol} vault is not owned by the vault authority`);
  });
  a.mints.forEach((x, i) => {
    const on = m.markets[i];
    if (!on || on.ticker !== x.symbol || !on.vault.equals(x.vault)) problems.push(`market ${i} should be ${x.symbol} with vault ${x.vault.toBase58()}`);
  });
  if (problems.length) throw new Error(`setup check failed:\n  ${problems.join("\n  ")}`);
  log(`setup verified: ${m.markets.length} markets, every vault owned by ${a.vaultAuthority.toBase58()}`);
}

// ───────────── keeper ─────────────

/** Prices to post (USD, 6 decimals) in market order, or null when no market is open. A market that is not open, or
 *  whose devnet price is stale, gets 0, which pauses borrowing there until the next post. */
async function readDevnet(source: ReturnType<typeof setup>, a: LendAddresses): Promise<bigint[] | null> {
  const { program } = source;
  const now = Math.floor(Date.now() / 1000);
  const markets = await fetchMarkets(program);
  const clocks = await program.account.assetClock.fetchMultiple(markets.map((m) => clockPda(m.publicKey)));
  const live = new Set(EXTENDED ? ["regular", "extended"] : ["regular"]);
  let anyOpen = false;
  const prices = a.mints.map(({ symbol, decimals }) => {
    const source = LISTED.find((l) => l.symbol === symbol)?.source ?? symbol;
    const i = markets.findIndex((m) => m.account.symbol === source);
    const m = markets[i]?.account;
    const c = clocks[i];
    if (!m || !c) return 0n;
    const open = FORCE || live.has(clockStateName(c.state));
    if (open) anyOpen = true;
    // Posted per 10⁶ base units: ÷100 for the xStocks' 8 decimals.
    const price = toPostedPrice(BigInt(m.price.toString()), decimals);
    return open && price > 0n && (FORCE || now - Number(m.priceUpdatedAt) <= SOURCE_MAX_AGE) ? price : 0n;
  });
  return anyOpen ? prices : null;
}

async function keeper() {
  const authority = loadKeypair(WALLET);
  const a = requireAddresses();
  const source = setup();
  const once = args.includes("--once");
  log(`Lend keeper on ${cluster} (${LEND_PROGRAM_ID.toBase58()}), authority ${authority.publicKey.toBase58()}; prices from devnet ${source.program.programId.toBase58()}`);
  let warned = false;
  for (;;) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [prices, info] = await Promise.all([readDevnet(source, a), conn.getAccountInfo(a.markets)]);
      const m = info && decodeMarkets(info.data);
      if (!m) throw new Error("markets account not found");
      if (!m.authority.equals(authority.publicKey)) throw new Error(`not the markets authority (${m.authority.toBase58()})`);
      // Post while open, every PRICE_SECS, or at once when a market's price must go to or from 0.
      const changed = prices && m.markets.some((x, i) => (x.price === 0n) !== (prices[i] === 0n));
      if (prices && (now - m.priceAt >= PRICE_SECS || changed)) {
        const sol = await balance(authority.publicKey);
        if (sol < MIN_BALANCE) {
          if (!warned) log(`balance ${sol.toFixed(6)} SOL is below LEND_MIN_BALANCE (${MIN_BALANCE}); not posting. Top up ${authority.publicKey.toBase58()}.`);
          warned = true;
        } else {
          warned = false;
          const sig = await send([lendIx.postPrices(a.markets, authority.publicKey, prices)], [authority]);
          log(`posted ${a.mints.map((x, i) => `${x.symbol} ${prices[i] ? usd(fromPostedPrice(prices[i]!, x.decimals)) : "paused"}`).join(", ")}: ${sig}`);
        }
      }
    } catch (e) {
      log("tick failed:", (e as Error).message);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, TICK_SECS * 1000));
  }
}

// ───────────── status ─────────────

async function status() {
  const program = await conn.getAccountInfo(LEND_PROGRAM_ID);
  console.log(`Finity Lend on ${cluster}: ${LEND_PROGRAM_ID.toBase58()} ${program?.executable ? "deployed" : "NOT DEPLOYED"}`);
  const a = lendAddresses(cluster);
  if (!a) return console.log("not seeded");
  const m = decodeMarkets((await conn.getAccountInfo(a.markets))?.data ?? new Uint8Array());
  if (!m) return console.log(`markets account ${a.markets.toBase58()} not found`);
  const now = Math.floor(Date.now() / 1000);
  console.log(`authority ${m.authority.toBase58()}: ${(await balance(m.authority)).toFixed(6)} SOL`);
  console.log(`prices posted ${m.priceAt ? `${now - m.priceAt}s ago` : "never"}; loan vault ${usd((await tokenBalance(a.loanVault)) ?? 0n)}`);
  const balances = await Promise.all(a.mints.map((x) => tokenBalance(x.vault)));
  for (const x of m.markets) {
    const held = balances[x.index] ?? 0n;
    const dec = a.mints[x.index]?.decimals ?? LEND_DECIMALS;
    console.log(`${x.ticker.padEnd(7)} ${x.price ? usd(fromPostedPrice(x.price, dec)).padStart(10) : "    paused"}  max LTV ${x.maxLtvBps / 100}%  collateral held ${(Number(held) / 10 ** dec).toLocaleString("en-US")}`);
  }
  const positions = (await fetchPositions(conn)).filter((p) => p.markets.equals(a.markets));
  const open = positions.filter((p) => p.debt > 0n);
  console.log(`${positions.length} position(s), ${open.length} with a loan, ${usd(open.reduce((s, p) => s + p.debt, 0n))} lent`);
}

// ───────────── fund / faucet ─────────────

async function fund() {
  if (cluster === "mainnet") throw new Error("on mainnet the loan money is the lender's USDC, supplied from the Lend page");
  const amount = BigInt(opt("amount") ?? 0);
  if (amount <= 0n) throw new Error("--amount <USD> required");
  const a = requireAddresses();
  if (args.includes("--lender")) {
    // To the lender's own wallet (creates its USD account: ≈0.002 SOL rent the first time), for it to supply itself.
    const lender = requireLender();
    const payer = loadKeypair(WALLET);
    const faucet = loadKeypair(FAUCET_WALLET);
    const sig = await send([lendIx.ensureAta(payer.publicKey, lender, a.usdMint), createMintToInstruction(a.usdMint, ataOf(lender, a.usdMint), faucet.publicKey, amount * ONE)], [payer, faucet], 40_000);
    log(`minted ${usd(amount * ONE)} test USD to the lender ${explorer(sig, "tx")}`);
    return;
  }
  const sig = await send([createMintToInstruction(a.usdMint, a.loanVault, loadKeypair(FAUCET_WALLET).publicKey, amount * ONE)], [loadKeypair(WALLET), loadKeypair(FAUCET_WALLET)], 20_000);
  log(`minted ${usd(amount * ONE)} test USD into the loan vault ${explorer(sig, "tx")}`);
}

/** Whole `amount` of a devnet test token to `to`. */
async function faucetTo(to: PublicKey, symbol: string, amount: bigint) {
  if (cluster === "mainnet") throw new Error("there are no test tokens on mainnet");
  const a = requireAddresses();
  const m = a.mints.find((x) => x.symbol.toLowerCase() === symbol.toLowerCase());
  if (!m) throw new Error(`unknown symbol ${symbol}`);
  const payer = loadKeypair(WALLET);
  const faucet = loadKeypair(FAUCET_WALLET);
  const ixs = [
    lendIx.ensureAta(payer.publicKey, to, m.mint, m.tokenProgram),
    createMintToInstruction(m.mint, ataOf(to, m.mint, m.tokenProgram), faucet.publicKey, amount * 10n ** BigInt(m.decimals), [], m.tokenProgram),
  ];
  return send(ixs, [payer, faucet], 40_000);
}

async function faucetCmd() {
  const to = opt("to");
  if (!to) throw new Error("--to <wallet> required");
  const symbol = opt("symbol") ?? "AAPLx";
  const sig = await faucetTo(new PublicKey(to), symbol, BigInt(opt("amount") ?? 10));
  log(`sent ${symbol} to ${to} ${explorer(sig, "tx")}`);
}

// ───────────── demo (devnet) ─────────────

async function demo() {
  if (cluster === "mainnet") throw new Error("demo is a devnet rehearsal (it mints test collateral)");
  const owner = loadKeypair(WALLET);
  const a = requireAddresses();
  const m = decodeMarkets((await conn.getAccountInfo(a.markets))!.data)!;
  const pick = m.markets.find((x) => x.price > 0n);
  if (!pick || Math.floor(Date.now() / 1000) - m.priceAt > 1200) throw new Error("no fresh price: run the keeper while a market is open");
  const tok = a.mints[pick.index]!;
  const sym = tok.symbol;
  await faucetTo(owner.publicKey, sym, 10n);
  const position = Keypair.generate();
  const coll = 10n * 10n ** BigInt(tok.decimals);
  const loan = maxLoan(coll, pick.price, pick.maxLtvBps) / 2n;
  let sig = await send(
    [
      lendIx.ensureAta(owner.publicKey, owner.publicKey, a.usdMint),
      await createProgramAccountIx(conn, owner.publicKey, position.publicKey, POSITION_LEN),
      lendIx.borrow(a, position.publicKey, owner.publicKey, pick.index, coll, loan, true),
    ],
    [owner, position],
  );
  log(`borrowed ${usd(loan)} against 10 ${sym}: ${explorer(sig, "tx")}`);
  sig = await send([lendIx.repay(a, position.publicKey, owner.publicKey, pick.index, loan)], [owner]);
  log(`repaid; collateral back: ${explorer(sig, "tx")}`);
  sig = await send([lendIx.close(position.publicKey, owner.publicKey)], [owner]);
  log(`closed the position, rent back: ${explorer(sig, "tx")}`);
}

// ───────────── teardown ─────────────

/** Needs the teardown build deployed (solana/lend/deploy.sh <cluster> --teardown). Returns every position's
 *  collateral to its owner and the remaining loan money to the lender, then closes the vaults and the markets
 *  account. Empty vaults are closed first, so their rent pays for any token account the returns have to create. */
async function teardown() {
  const authority = loadKeypair(WALLET);
  const lender = requireLender();
  const a = requireAddresses();
  const start = await balance(authority.publicKey);
  const closeEmptyVaults = async () => {
    for (const v of [...a.mints, { symbol: "loan", mint: a.usdMint, vault: a.loanVault, tokenProgram: TOKEN_PROGRAM_ID }]) {
      const held = await tokenBalance(v.vault);
      if (held === null || held > 0n) continue;
      // Op 1 ignores the destination slot, but it must be an account not already in the instruction.
      const unused = Keypair.generate().publicKey;
      const sig = await send([lendIx.vaultAdmin(a, authority.publicKey, v.vault, unused, 1, 0n, v.mint, v.tokenProgram)], [authority], 30_000);
      log(`closed the ${v.symbol} vault ${explorer(sig, "tx")}`);
    }
  };
  await closeEmptyVaults();
  const positions = await fetchPositions(conn);
  for (const p of positions.filter((x) => x.collateral > 0n && x.markets.equals(a.markets))) {
    const m = a.mints[p.index]!;
    const sig = await send(
      [
        lendIx.ensureAta(authority.publicKey, p.owner, m.mint, m.tokenProgram),
        lendIx.vaultAdmin(a, authority.publicKey, m.vault, ataOf(p.owner, m.mint, m.tokenProgram), 0, p.collateral, m.mint, m.tokenProgram),
      ],
      [authority],
      60_000,
    );
    log(`returned ${Number(p.collateral) / 10 ** m.decimals} ${m.symbol} to ${p.owner.toBase58()} ${explorer(sig, "tx")}`);
  }
  // What is left of the pool goes back to the lender.
  const left = (await tokenBalance(a.loanVault)) ?? 0n;
  if (left > 0n) {
    const sig = await send(
      [lendIx.ensureAta(authority.publicKey, lender, a.usdMint), lendIx.vaultAdmin(a, authority.publicKey, a.loanVault, ataOf(lender, a.usdMint), 0, left, a.usdMint)],
      [authority],
      60_000,
    );
    log(`returned ${usd(left)} of loan money to the lender ${explorer(sig, "tx")}`);
  }
  await closeEmptyVaults();
  for (const v of [{ symbol: "USD", vault: a.loanVault }, ...a.mints]) {
    const held = await tokenBalance(v.vault);
    if (held !== null && held > 0n) log(`${v.symbol} vault still holds ${held} units (collateral of an unknown position?); left open`);
  }
  const sig = await send([lendIx.close(a.markets, authority.publicKey)], [authority], 10_000);
  log(`closed the markets account ${explorer(sig, "tx")}`);
  LEND.clusters[cluster] = null;
  saveBook();
  log(`recovered ${((await balance(authority.publicKey)) - start).toFixed(6)} SOL. Close the program with:
  solana program close ${LEND_PROGRAM_ID.toBase58()} --bypass-warning -u${cluster === "mainnet" ? "m" : "d"} --keypair ${WALLET}
${cluster === "devnet" ? "The devnet test mints stay (they cannot be closed)." : ""}`);
}

const commands: Record<string, () => Promise<void>> = { seed, keeper, status, fund, faucet: faucetCmd, demo, teardown };
if (!commands[cmd]) throw new Error(`unknown command ${cmd}; one of ${Object.keys(commands).join(", ")}`);
await commands[cmd]();
