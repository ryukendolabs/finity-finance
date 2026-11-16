# Finity Finance
<img width="2852" height="1570" alt="Screenshot from 2026-11-16 01-48-57" src="https://github.com/user-attachments/assets/d676fea5-8ca4-4347-a47d-b5f93eca9db7" />


A lending protocol on Solana for tokenized stocks and tokenized Treasury funds that follows each asset's market clock.

Stocks stop trading when their market closes, and Treasury funds price once a day. Lending protocols built for
crypto-native assets assume a live price always exists, so they either liquidate on stale weekend prices or leave
lenders silently carrying the Friday-to-Monday gap. Finity instead tracks every asset's market state, makes loans
weekend-safe before the close (or insured), prices the reopen gap and sells it to a first-loss underwriter pool, and
clears liquidations in uniform-price batch auctions instead of a bot race.

> **Status:** live on Solana devnet with test tokens. Not audited. Do not use with real funds.

## How it works

| # | Mechanism | What it does |
| --- | --- | --- |
| 1 | **Asset Clock** | Tracks each asset's market state on-chain: open, extended hours, closed, halted, reopening |
| 2 | **Bell Check** | From 2 hours before every close, each loan must be at the closure-safe LTV or carry Gap Cover (auto-cover by default) |
| 3 | **Gap Cover + Underwriter Pool** | A first-loss pool sells insurance on the reopen gap, priced on 256 stress scenarios, and absorbs bad debt first |
| 4 | **Batch Auctions** | Every liquidation clears at one uniform price: intraday, extended hours, sealed-bid at the reopen, or pre-close |

Everything runs in one Anchor program, [`solana/programs/finity`](solana/programs/finity/). Inputs fail closed: if
the clock, the prices or the calendar disagree, the asset is treated as closed. Keepers are untrusted; every keeper
action is checked on-chain.

| Area | What the program does |
|---|---|
| Lending | Borrow test USDC against six test stock tokens (75% max LTV) and a T-Bill fund (90%); kinked interest per market; Senior Vault with shares and a FIFO redeem queue |
| Market clock | NYSE and US-bank calendars on-chain; closures, Bell window and deadline, open print, REOPEN, guardian halts |
| Risk engine | Calibrated scenario sets and σ per market and closure type (weekend gaps since 2016); closure-safe LTV on debt projected to the reopen |
| Underwriting | Two Underwriter Pools (stocks, T-Bill) in calendar epochs; Gap Cover priced on 256 joint stress scenarios |
| Loss waterfall | Pool → protocol reserve → Senior Vault |
| Auctions | INTRADAY (60 s), EMERGENCY (extended hours, never a covered loan), sealed-bid REOPEN, PRECLOSE; the pool buys what bidders don't at the reserve |
| Pool inventory | What the pool buys counts in its NAV at min(value, cost); stocks are resold by a gradual Dutch auction, T-Bill fund tokens are redeemed with the fund (T+1) |
| Oracle | Prices only as Ed25519-signed reports from 2 of 3 relayers, checked on-chain (median, freshness, ordering) |
| Guardian | Borrow and cover pauses and a temporary max-LTV haircut; the admin role and upgrade authority can move to a Squads multisig |

Every risk formula is tested bit for bit against the reference crate in [`solana/reference/risk-core`](solana/reference/risk-core/).

## Services

| Service | Port | What it does |
|---|---|---|
| Relayers 1–3 | 7701–7703 | Each reads stock quotes and signs price reports with its own key; holds no SOL and sends nothing |
| Keeper | — | Forwards signed prices, pokes clocks, runs epochs, the Bell's auto-cover, auctions (and a test solver), the pool's inventory, the redeem queue and the notifier |
| Indexer | — | Records transactions, prices, clock transitions, auctions and pool NAV into SQLite |
| Public API | 8787 | Read-only JSON: markets, pools, auctions, positions, history; `/v1/openapi.json`, `/v1/health`, Prometheus `/metrics` |
| Web app | 3000 | Every page: Overview, Markets, Borrow, Lend, Underwrite, Auctions, Risk, Alerts, Account, Settings, Faucet |

Alerts (the Bell, loans close to an auction, auction results, epoch settlements, withdrawals ready) land in an inbox
behind Sign-In With Solana, and can also go out by browser push, email or Telegram (Settings → Notifications).

## Try it

1. Open the web app, switch your wallet (Phantom, Solflare, Backpack) to **devnet**, and connect.
2. **Faucet:** get test stock tokens and test USDC (you need a little devnet SOL for fees).
3. **Borrow:** deposit a stock token and borrow USDC; before a close, the Bell asks for a safe LTV or Gap Cover.
4. **Lend** USDC to the Senior Vault, or **Underwrite** the weekend gap in a pool.
5. **Auctions:** bid on liquidation lots, or buy what the pool holds from its falling-price resale.

## Devnet

| | |
|---|---|
| Program | [`9GUKJUTYMZpvRhkfQyvVZ3j1Y8rcjKPfwJ5ovmfU9bY1`](https://explorer.solana.com/address/9GUKJUTYMZpvRhkfQyvVZ3j1Y8rcjKPfwJ5ovmfU9bY1?cluster=devnet) |
| Address book | [`solana/client/devnet.json`](solana/client/devnet.json) (USDC and stock mints) |
| Markets | AAPL, AMZN, GOOGL, MSFT, NVDA, TSLA (NYSE calendar) and TBILL (US-bank calendar) |
| Plan and status | [`docs/solana-devnet-migration-plan.md`](docs/solana-devnet-migration-plan.md) |

## Mainnet

**Finity V2** puts the Asset Clock and the Bell Check on Solana mainnet as a 6.6 KB program
([`solana/v2`](solana/v2/)): deploy and seed cost ~0.043 SOL (~$3). Its keeper mirrors the devnet protocol's clock, oracle price and
calibrated safe LTV, and the web app's **Mainnet** page lets a wallet open, Bell-check and close positions. Costs and
steps: [`docs/mainnet.md`](docs/mainnet.md).

## Repository layout

| Path | What it is |
| --- | --- |
| [`solana/programs/finity`](solana/programs/finity/) | Anchor program and its LiteSVM integration tests |
| [`solana/reference/risk-core`](solana/reference/risk-core/) | Reference fixed-point risk math for the differential tests |
| [`solana/data/calibration`](solana/data/calibration/) | Calendars, scenario sets, joint stress columns and σ tables loaded on-chain |
| [`solana/v2`](solana/v2/) | Finity V2: the mainnet program (Pinocchio, no Anchor), its LiteSVM tests and `deploy.sh` |
| [`solana/client`](solana/client/) | TypeScript client (`@finity/solana`): IDL, PDAs, markets, math ports, address book |
| [`solana/scripts`](solana/scripts/) | Seed and loaders, keeper, relayer, indexer, API, notifier, smoke and e2e checks, devnet upgrade, multisig handover |
| [`solana/notify`](solana/notify/) | Alert inbox (SQLite) and delivery by push, email and Telegram |
| [`apps/web`](apps/web/) | Web app (Next.js, Solana wallet-adapter), its RPC proxy and Sign-In With Solana |
| [`infra/local`](infra/local/) | systemd user services that host every service on one machine |

## Getting started

Prerequisites (pinned in `.tool-versions`): Rust 1.95, Solana CLI 3.1, Anchor 1.1, Node 24, pnpm 10.

```sh
pnpm install
cd solana
anchor build && cargo test     # program + LiteSVM integration tests and risk-core differential tests
pnpm seed                      # mints, config, markets, Senior Vault liquidity
pnpm load-risk                 # calendars, clocks, risk parameters and scenario sets
pnpm load-pool                 # reserve, Underwriter Pools, joint stress columns, first-loss capital
pnpm load-oracle               # relayer signer set (2 of 3) and guardian; keys in ~/.config/finity (mode 600)
RELAYER_INDEX=1 pnpm relayer   # a price relayer (1..3), on 127.0.0.1:7701..7703
pnpm bot                       # keeper (with RELAYER_URLS set, it forwards the relayers' signed reports)
pnpm indexer                   # history into ~/.local/share/finity/index.db
pnpm api                       # public read-only API on 127.0.0.1:8787
```

Every loader is idempotent. To host everything on this machine as auto-restarting systemd user services, run
`infra/local/up.sh` (web on http://localhost:3000, API health on http://127.0.0.1:8787/v1/health, logs via
`journalctl --user -fu finity-bot`, stop with `infra/local/down.sh`). For the web app alone:
`cd apps/web && cp .env.example .env.local && pnpm dev`.

### Configuration

Private settings live in `~/.config/finity/env` (mode 600), read by every service; keys sit next to it.

| Variable | Used for |
|---|---|
| `SOLANA_RPC_URL` | A private devnet RPC (e.g. QuickNode). The browser reaches it only through the app's `/api/rpc` proxy, so the key never leaves the server |
| `SMTP_URL`, `SMTP_FROM` | Email alerts (off when unset) |
| `TELEGRAM_BOT_TOKEN` | Telegram alerts (off when unset) |
| `FINITY_APP_URL` | Links in alerts (default http://localhost:3000) |

Browser push needs no account: its key pair is generated into `~/.config/finity/vapid.json`.

### Checks

```sh
cd solana
cargo test                     # 89 tests: program unit + integration, risk-core differential
pnpm smoke                     # on devnet: faucet → deposit → borrow → repay → withdraw, lend → redeem
pnpm e2e                       # on devnet: pool deposit, relayers, API, indexer, every web page, the RPC proxy
```

### Operations

```sh
solana/scripts/deploy-devnet.sh               # SOL check → build → upgrade → loaders → services → smoke
cd solana && MEMBERS=a,b,c THRESHOLD=2 pnpm handover   # dry run; add --execute to hand admin + upgrades to Squads
```

## Limits

Devnet only: test tokens, quotes from Yahoo Finance signed by our own relayer keys, a T-Bill fund whose redemptions
the protocol itself pays, one keeper without failover, and SQLite instead of a database server. No audit.

## License

MIT. See [LICENSE](LICENSE).
