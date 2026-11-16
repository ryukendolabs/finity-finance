# Finity V2 on mainnet

The full protocol keeps running on devnet. Finity V2 (`solana/v2`, a 6,664-byte Pinocchio program) puts its two
distinctive rules on Solana mainnet: each market's clock (open, extended, closed, halted, reopen; next close and
reopen) and the Bell Check (from two hours before the close, positions must be at the closure-safe LTV). Its keeper
mirrors the devnet program: clock state, the oracle price (2-of-3 relayer-signed and verified on devnet) and the safe
LTV computed from the calibrated risk sets. Users open positions from the web app's **Mainnet** page with their own
wallet. Positions are records: no tokens move, so no funds are at risk.

## Cost

Rent is a refundable deposit; fees are 0.000005 SOL per signature. SOL figures are exact (`solana rent` on mainnet,
16 Nov 2026); dollar figures use $70.8/SOL.

| Item | SOL | USD |
|---|---|---|
| Program data (6,664 bytes) | 0.034503 | 2.44 |
| Program account | 0.000833 | 0.06 |
| Deploy fees | ~0.0003 | 0.02 |
| 7 markets × 0.001097 | 0.007681 | 0.54 |
| **Deploy + seed** | **~0.0434** | **~3.07** |
| Keeper | ~0.0006 per trading day (writes only what changed: price every 4 min while open, hourly while closed) | ~0.04/day |

Fund **0.05 SOL (~$3.55)**: deploy, seed and about two weeks of keeper fees. Rehearsed end to end on devnet (same
program address, `GvaQuq1tNpPHu3ZvKcxZ4dNSze59EMPBq7u3TMYyHAxx`).

## Steps

1. **Fund the authority.** Send **0.05 SOL** to `2jUycByYFs2mBR6xsuHsKiCnVMec8uxJanmAwpNubto2`
   (key: `~/.config/finity/mainnet-authority.json`, mode 600). It pays for everything and is the upgrade and
   market authority.
2. **Mainnet RPC (recommended).** Add `V2_RPC_URL=<mainnet endpoint>` to `~/.config/finity/env`. The public
   endpoint works for a light load but rate-limits.
3. **Deploy.** `solana/v2/deploy.sh mainnet`: builds, runs the tests, prints the exact cost and asks before
   sending anything.
4. **Seed markets.** `cd solana && pnpm v2 seed --cluster mainnet` (all 7 markets, or `--markets AAPL,NVDA,TSLA`
   to save 0.0011 SOL each). Writes the addresses into `solana/client/v2.json`; commit that file so the web app
   can find the markets.
5. **Keeper.** `infra/local/up.sh` starts `finity-v2-keeper` once steps 1 and 4 are done. Check it with
   `pnpm v2 status --cluster mainnet` and `journalctl --user -fu finity-v2-keeper`.
6. **Web app.** Set `V2_RPC_URL` on the web host too (the `/api/rpc/mainnet` proxy uses it). The **Mainnet**
   page reads the markets from `client/v2.json`.

**Afterwards (optional):** `pnpm v2 close-all --cluster mainnet` returns the markets' rent, and
`solana program close GvaQuq1tNpPHu3ZvKcxZ4dNSze59EMPBq7u3TMYyHAxx --bypass-warning -um --keypair ~/.config/finity/mainnet-authority.json`
returns the program's. What's left as the real cost is fees: well under $1.
