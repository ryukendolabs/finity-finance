// The notifier: derives each wallet's alerts from on-chain state and files them in the
// inbox the web app reads. Keys make every alert unique, so re-deriving each tick never repeats one.
import type { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

import {
  CLOSURE_NAMES,
  borrowRateWad,
  epochPda,
  accrued,
  clockPda,
  fetchMarkets,
  fetchPositions,
  fromUnits,
  lockPda,
  policyPda,
  positionHealth,
  projectedDebt,
  riskConfigPda,
  riskSetPda,
  safeLtvWad,
  type Finity,
} from "../client/index";
import { deliverPending } from "../notify/deliver";
import { addAlert } from "../notify/store";

const exists = async (p: Program<Finity>, k: PublicKey) => (await p.provider.connection.getAccountInfo(k)) !== null;

export async function notify(program: Program<Finity>, log: (...a: unknown[]) => void) {
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  const add = (a: Parameters<typeof addAlert>[0]) => {
    if (addAlert(a)) added++;
  };
  const [markets, positions, cfg] = await Promise.all([fetchMarkets(program), fetchPositions(program), program.account.riskConfig.fetchNullable(riskConfigPda())]);

  for (const { publicKey: market, account: m } of markets) {
    const clock = await program.account.assetClock.fetchNullable(clockPda(market));
    for (const { publicKey: position, account: p } of positions) {
      if (!p.market.equals(market) || p.borrowShares.isZero()) continue;
      const wallet = p.owner.toBase58();
      const h = positionHealth(m, p, now);
      const hf = h.debt > 0 ? h.liqLimit / h.debt : Infinity;

      // Health under 1.10: close to an auction.
      if (hf < 1.1) {
        add({
          wallet, key: `risk:${position.toBase58()}:${Math.floor(now / 86_400)}`, event: "LOAN_AT_RISK",
          subject: `${m.symbol} loan health ${hf.toFixed(2)}`,
          body: `Your ${m.symbol} loan is at ${((100 * h.debt) / h.value).toFixed(1)}% LTV against an ${m.liqThresholdBps / 100}% liquidation line. Repay or add collateral to stay out of an auction.`,
          url: "/app/borrow",
        });
      }

      // The Bell: in the Bell window, above the closure's safe LTV and not covered.
      if (clock && cfg && now >= Number(clock.bellWindowAt) && now < Number(clock.nextCloseAt)) {
        const upcoming = Number(clock.closureId) + 1;
        if (!(await exists(program, policyPda(market, p.owner, upcoming)))) {
          const set = await program.account.riskSet.fetchNullable(riskSetPda(market, clock.nextClosureType));
          if (set) {
            const safe = Number(safeLtvWad({ n: set.n, sigma: set.sigma, dividend: set.dividend, zTail: set.zTail }, cfg, m.maxLtvBps)) / 1e18;
            const days = Math.max(1, Math.ceil((Number(clock.nextReopenAt) - Number(clock.nextCloseAt)) / 86_400));
            const l = accrued(m, now);
            const dProj = Number(projectedDebt(h.debtRaw, borrowRateWad(l.supply, l.borrow, m.rate), days)) / 1e6;
            if (h.value > 0 && dProj / h.value > safe) {
              add({
                wallet, key: `bell:${position.toBase58()}:${upcoming}`, event: "BELL_DUE",
                subject: `Bell due: ${m.symbol} before the ${(CLOSURE_NAMES[clock.nextClosureType] ?? "next").toLowerCase()} close`,
                body: `Your ${m.symbol} loan is above the closure-safe ${(100 * safe).toFixed(1)}% LTV. Repay, add collateral or buy Gap Cover before the Bell deadline; after it the Bell acts for you.`,
                url: "/app/borrow",
              });
            }
          }
        }
      }

      // In an auction.
      const lock = await program.account.positionLock.fetchNullable(lockPda(position));
      if (lock && !lock.auction.equals(PublicKey.default)) {
        add({
          wallet, key: `auction:${lock.auction.toBase58()}:${wallet}`, event: "IN_AUCTION",
          subject: `${m.symbol} loan joined an auction`,
          body: `Part of your ${m.symbol} collateral is being sold in a batch auction at one uniform price. Repaying now can't stop a lot that's already fixed.`,
          url: "/app/auctions",
        });
      }
    }
  }

  // Settled auction lots.
  for (const { account: e } of await program.account.lotEntry.all()) {
    if (!e.settled || e.qty.isZero()) continue;
    add({
      wallet: e.owner.toBase58(), key: `settled:${e.auction.toBase58()}:${e.owner.toBase58()}`, event: "LOT_SETTLED",
      subject: "Auction settled for your loan",
      body: `${fromUnits(e.qty).toFixed(4)} collateral sold; the proceeds repaid your debt (any surplus was refunded to your wallet).`,
      url: "/app/borrow",
    });
  }

  // Pool epochs ready to claim.
  for (const { account: t } of await program.account.poolTicket.all()) {
    const e = await program.account.epoch.fetchNullable(epochPda(t.pool, BigInt(t.epochSeq.toString())));
    if (e?.phase !== 3) continue;
    add({
      wallet: t.owner.toBase58(), key: `claim:${t.pool.toBase58()}:${t.epochSeq.toString()}:${t.owner.toBase58()}`, event: "EPOCH_CLAIM",
      subject: `Pool epoch #${t.epochSeq.toString()} settled`,
      body: "Your queued deposit or exit is ready to claim on the Underwrite page.",
      url: "/app/underwrite",
    });
  }

  // Senior vault redemptions paid.
  for (const { account: r } of await program.account.redeemRequest.all()) {
    if (!r.processed) continue;
    add({
      wallet: r.owner.toBase58(), key: `redeem:${r.id.toString()}`, event: "REDEEM_READY",
      subject: `Withdrawal #${r.id.toString()} is ready`,
      body: `${fromUnits(r.assets).toFixed(2)} USDC from the Senior Vault is ready to claim on the Lend page.`,
      url: "/app/lend",
    });
  }
  if (added) log(`notifier: ${added} new alert(s)`);
  const sent = await deliverPending(log);
  if (sent) log(`notifier: ${sent} delivered by email / Telegram / push`);
}

