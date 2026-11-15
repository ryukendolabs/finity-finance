# Finity Finance on Solana devnet: plan and status

**Owner:** PM · **Updated:** 2026-11-16 · **Status:** complete on devnet; next is the multisig handover

## 1. Goal

Move the whole protocol (every contract and every service) from the EVM stack to Solana devnet, so anyone with a
Solana wallet can use it end to end: get test tokens, borrow against stocks, buy Gap Cover, lend to the Senior
Vault, underwrite the weekend gap, and bid in liquidation auctions.

## 2. Contracts → one Anchor program

| EVM contract | Solana (program `9GUKJUTYMZpvRhkfQyvVZ3j1Y8rcjKPfwJ5ovmfU9bY1`) | Status |
|---|---|---|
| Market: borrow, repay, interest, borrow shares | `user.rs`, `math.rs` | Live |
| Senior Vault: shares, FIFO redeem queue | `lend.rs`, `vault_markets.rs` | Live |
| Asset clock and calendars | `clock.rs`, `clock_ix.rs` | Live |
| Risk engine: safe LTV, σ limits, scenario sets, cover pricing, capacity | `risk.rs`, checked against `reference/risk-core` | Live |
| Underwriter Pools, epochs, Gap Cover, the Bell, loss waterfall, reserve | `pool_ix.rs`, `cover_ix.rs`, `liquidate.rs` | Live |
| Auction house: INTRADAY, EMERGENCY, sealed REOPEN, PRECLOSE | `auction_ix.rs` | Live |
| Pool inventory: GDA resale, NAV mark | `inventory_ix.rs` | Live |
| Settlement adapter: T-Bill redemption with the fund (κ_nav reserve) | `inventory_ix.rs` | Live |
| Price feed: Ed25519-signed k-of-n reports (tag `FNTY`) | `oracle_ix.rs` | Live |
| Guardian: pauses, haircut; admin handover | `oracle_ix.rs` | Live |
| Faucet and test tokens | `faucet.rs` | Live |

## 3. Services

| EVM service | Solana | Status |
|---|---|---|
| Price relayers (2 of 3) | `scripts/relayer.ts`, three processes, one key each | Running |
| Keeper | `scripts/bot.ts` (+ `auctions.ts`) | Running |
| Bidder bot | The keeper's auction solver | Running |
| Notifier: inbox, email, push, Telegram | `scripts/notifier.ts`, `notify/` | Running (email and Telegram need credentials) |
| Indexer | `scripts/indexer.ts` (SQLite) | Running |
| Public API with OpenAPI | `scripts/api.ts` | Running |
| Monitoring | `/v1/health` and Prometheus `/metrics` | Running |
| Web app | `apps/web` | Running |
| Governance handover | `scripts/handover-squads.ts` (Squads v4) | Ready, not executed |

All of it is hosted on one machine as systemd user services (`infra/local/up.sh`).

## 4. How it was built

| Stage | Scope |
|---|---|
| MVP | Faucet, deposit, borrow, repay, admin prices, market-hours cap |
| 1 | Senior Vault, kinked interest, borrow shares, fee split, redeem queue |
| 2 | Market clock and risk engine |
| 3 | Underwriter Pools, epochs, Gap Cover, auto-cover, loss waterfall |
| 4 | Batch auctions, lot sizing, pool backstop, settlement |
| 5 | Signed oracle, guardian, admin handover |
| 6 | Overview, Account, Settings, Alerts with Sign-In With Solana |
| 7 | One-command devnet upgrade, local hosting |
| 8 | Pool inventory (GDA resale, NAV mark), T-Bill redemptions, EMERGENCY auctions, pool migration |
| 9 | Separate relayers, indexer, public API, alert delivery, Squads handover script, `FNTY` report tag |

## 5. Verification (2026-11-16)

- `cargo test`: 89 tests pass (program unit and LiteSVM integration tests, risk-core differential tests).
- `pnpm smoke` on devnet: faucet → deposit → borrow → repay → withdraw, lend → redeem.
- `pnpm e2e` on devnet: pool deposit, three relayers, API and indexer, every web page, the RPC proxy (25 checks).
- Every app page renders in a browser without errors; prices reach the chain signed by the three relayers.
- Auction, inventory, T-Bill redemption and EMERGENCY flows are covered by the integration tests; on devnet they run
  only when a real loan becomes unhealthy.

## 6. Next

1. Choose the multisig members, then `MEMBERS=… THRESHOLD=… pnpm handover --execute`.
2. Add an SMTP account and a Telegram bot token to `~/.config/finity/env` to turn on those alert channels.
3. Before mainnet: licensed price data, independent relayer operators, keeper failover, a database server, an audit.

## 7. Not production-safe

Test tokens, an unofficial quote source signed by our own relayer keys, a T-Bill fund whose redemptions the protocol
pays, and no audit. It must not hold real value.
