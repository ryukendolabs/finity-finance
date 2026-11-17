# Finity Lend on mainnet

The full protocol keeps running on devnet. Finity Lend (`solana/lend`, a 9,384-byte Pinocchio program) puts borrowing on
Solana mainnet with real tokens:

- **Collateral:** the six xStocks: AAPLx, AMZNx, GOOGLx, MSFTx, NVDAx, TSLAx (Token-2022, 8 decimals).
- **Loan:** USDC (SPL Token, 6 decimals), from one pool supplied by the lender's wallet.
- **Limit:** 55% LTV (the full protocol's closure-safe level), checked when borrowing against a price at most 20 minutes old.
- **Repaying** works at any time; paying a loan off returns all its collateral. No interest, no liquidation.
- **Prices:** the keeper (`pnpm lend keeper`, service `finity-lend-keeper`) posts all six in one transaction every 15 minutes
  while US markets are open (regular hours), from the devnet protocol's oracle. Outside those hours borrowing waits.

## Risks the lender takes

- No liquidation: if a stock falls past its limit, a borrower can keep the USDC and the pool takes the loss.
- The markets authority (the keeper's key) posts the prices; whoever holds it could post a wrong price.
- The xStock issuer can move tokens out of any account (permanent delegate) and pause transfers.

## Cost (mainnet rent, 5,080 lamports per byte)

| Item | SOL |
| --- | --- |
| Program (9,384 bytes) + program account | 0.049383 |
| Markets account (528 bytes) | 0.003332 |
| 6 xStock vaults (179 bytes) + USDC vault (165 bytes) | 0.010846 |
| Fees | ~0.000250 |
| **Total** | **≈ 0.0638** |

The fee payer also keeps its 0.00065 SOL minimum. A price update costs 0.000005 SOL (about 0.00014 SOL per trading day).
Growing a deployed program needs at least 10,240 more bytes (≈ 0.053 SOL), so deploy the final build the first time.

## Steps

1. **Keys** (never in the repo, `~/.config/finity`, mode 600): `mainnet-authority.json` (payer, upgrade authority, markets
   authority and keeper), `finity-lend-program.json` (program address `He1CGvMi3EbBPiWJ4jdqgQhF5fauqSGq8nFHbo1DjQmL`).
   `env` holds `LEND_LENDER`, `GAS_SPONSOR_KEY` and optionally `LEND_RPC_URL` (a private mainnet RPC).
2. **Fund** the authority with ≈ 0.0706 SOL.
3. **Deploy:** `solana/lend/deploy.sh mainnet` builds the three variants, runs the tests, prints the exact cost and asks
   before sending.
4. **Set up:** `cd solana && pnpm lend seed --cluster mainnet` checks the real mints on-chain, creates the markets account
   and vaults, lists the markets and verifies them. It writes `solana/client/lend.json`; commit it so the web app uses it.
5. **Keeper:** `infra/local/up.sh` starts `finity-lend-keeper` once the cluster is seeded.
   `pnpm lend status --cluster mainnet` and `journalctl --user -fu finity-lend-keeper` show it working.
6. **Supply:** the lender's wallet opens the Lend page and supplies USDC.

## Shutting down

`solana/lend/deploy.sh mainnet --teardown` replaces the program with the smaller teardown build (no extra rent), then
`pnpm lend teardown --cluster mainnet` returns every position's collateral to its owner and the rest of the pool to the
lender, closes the vaults and the markets account, and prints the command that closes the program and returns its rent.

## Rehearsing on devnet

`solana/lend/deploy.sh devnet`, then `pnpm lend seed|keeper --force|demo|status|teardown --cluster devnet`. Devnet uses
Token-2022 test mints shaped like the xStocks and a test USD mint.
