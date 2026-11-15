"use client";

import {
  AUCTION_KIND,
  AUCTION_KIND_NAME,
  BN,
  STOCK_DECIMALS,
  auctionBookPda,
  auctionPda,
  bidCommitment,
  bidPda,
  calendarPda,
  clockPda,
  gdaQuote,
  inventoryPda,
  KAPPA_NAV,
  poolPda,
  redemptionPda,
  riskConfigPda,
} from "@finity/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Row, units, type Spec } from "../actions";
import { GradientCard, H, KV, Note, PageHead, Pill, StatBlock, num, pct, usd } from "../ui";
import { ErrorNote } from "./shared";
import { useApp, useNow } from "@/lib/app";
import { ticker, tokenLogo } from "@/lib/protocol";
import { LOAN_SYMBOL, USDC_DECIMALS, USDC_MINT, useProgram, useRiskConfig, type Market } from "@/lib/solana";
import { et } from "@/lib/time";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { configPda, usdcVaultPda, vaultPda } from "@finity/solana";

type AuctionRow = {
  key: PublicKey;
  id: number;
  market: Market;
  kind: number;
  phase: number;
  deadlines: number[];
  lot: number;
  reserve: number;
  pStar: number;
  qPool: number;
  bids: number;
  positions: number;
};

type MyBid = { auction: PublicKey; qty: number; price: number; fill: number; revealed: boolean; claimed: boolean; bond: number; sealed: boolean };

/** Sealed bids' secrets, kept on this device (needed to reveal). */
type Saved = { auction: string; qty: string; price: string; salt: number[] };
const savedKey = (owner: string) => `cx-sealed-${owner}`;
function loadSaved(owner: string): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(savedKey(owner)) ?? "[]") as Saved[];
  } catch {
    return [];
  }
}
function storeSaved(owner: string, all: Saved[]) {
  try {
    localStorage.setItem(savedKey(owner), JSON.stringify(all));
  } catch {
    /* no storage: the reveal will need the backup */
  }
}

/** The phase a viewer sees: windows come from the deadlines, results from the account. */
function phaseOf(a: AuctionRow, now: number): string {
  if (a.phase === 4) return "Cleared";
  if (a.phase === 5) return "Cancelled";
  const [fix, start, end, clear] = a.deadlines as [number, number, number, number];
  if (now < fix) return "Queue";
  if (a.kind === AUCTION_KIND.REOPEN) return now < end ? "Commit" : now < clear ? "Reveal" : "Clearing";
  return now >= start && now < end ? "Open" : now < clear ? "Fixing" : "Clearing";
}

function useAuctions(markets: Market[]) {
  const program = useProgram();
  return useQuery({
    queryKey: ["auctions", markets.map((m) => m.symbol).join()],
    enabled: markets.length > 0,
    refetchInterval: 10_000,
    queryFn: async (): Promise<AuctionRow[]> => {
      const books = await program.account.auctionBook.fetchMultiple(markets.map((m) => auctionBookPda(m.key)));
      const keys: { m: Market; id: number; key: PublicKey }[] = [];
      books.forEach((b, i) => {
        const last = b ? Number(b.nextId.toString()) : 0;
        for (let id = last; id >= Math.max(1, last - 5); id--) keys.push({ m: markets[i]!, id, key: auctionPda(markets[i]!.key, id) });
      });
      const rows = await program.account.auction.fetchMultiple(keys.map((k) => k.key));
      const u = (x: BN) => Number(x.toString()) / 1e6;
      return keys
        .flatMap((k, i) => {
          const a = rows[i];
          if (!a) return [];
          return [{
            key: k.key, id: k.id, market: k.m, kind: a.kind, phase: a.phase, deadlines: a.deadlines.map((d) => Number(d.toString())),
            lot: Number(a.lot.toString()) / 10 ** STOCK_DECIMALS, reserve: u(a.reserve), pStar: u(a.pStar),
            qPool: Number(a.qPool.toString()) / 10 ** STOCK_DECIMALS, bids: a.bidCount, positions: a.positions,
          }];
        })
        .sort((a, b) => b.deadlines[3]! - a.deadlines[3]!);
    },
  });
}

/** The pool's backstop inventory per token, with its running GDA and (T-Bill) redemptions. */
type InventoryRow = {
  market: Market;
  pool: PublicKey;
  key: PublicKey;
  qty: number;
  cost: number;
  mark: number;
  nav: boolean;
  gda: { active: boolean; qty: number; sold: number; raw: { k: BN; decay: BN; emissionPerSec: BN; sold: BN; start: BN } };
};
type RedemptionRow = { id: number; market: Market | undefined; qty: number; cost: number; readyAt: number; claimed: boolean; assets: number };

function useInventory(markets: Market[]) {
  const program = useProgram();
  return useQuery({
    queryKey: ["inventory", markets.map((m) => m.symbol).join()],
    enabled: markets.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<{ rows: InventoryRow[]; redemptions: RedemptionRow[] }> => {
      const pools = markets.map((m) => poolPda(m.marketHours ? "XNYS" : "USBANK"));
      const invs = await program.account.inventory.fetchMultiple(markets.map((m, i) => inventoryPda(pools[i]!, m.mint)));
      const d = () => 10 ** STOCK_DECIMALS;
      const rows = invs.flatMap((v, i) => {
        if (!v) return [];
        const m = markets[i]!;
        return [{
          market: m, pool: pools[i]!, key: inventoryPda(pools[i]!, m.mint), qty: Number(v.qty.toString()) / d(), cost: Number(v.cost.toString()) / 1e6,
          mark: Number(v.mark.toString()) / 1e6, nav: v.nav,
          gda: { active: v.gda.active, qty: Number(v.gda.qty.toString()) / d(), sold: Number(v.gda.sold.toString()) / d(), raw: v.gda },
        }];
      });
      const reds = await program.account.redemption.all();
      const redemptions = reds
        .map(({ account: r }) => ({
          id: Number(r.id.toString()), market: markets.find((m) => m.key.equals(r.market)), qty: Number(r.qty.toString()) / 10 ** STOCK_DECIMALS,
          cost: Number(r.cost.toString()) / 1e6, readyAt: Number(r.readyAt.toString()), claimed: r.claimed, assets: Number(r.assets.toString()) / 1e6,
        }))
        .sort((a, b) => b.id - a.id);
      return { rows, redemptions };
    },
  });
}

function useMyBids() {
  const program = useProgram();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["my-bids", publicKey?.toBase58()],
    enabled: !!publicKey,
    refetchInterval: 10_000,
    queryFn: async (): Promise<MyBid[]> => {
      // Bid layout: discriminator (8), auction (32), bidder (32).
      const rows = await program.account.bid.all([{ memcmp: { offset: 40, bytes: publicKey!.toBase58() } }]);
      return rows.map(({ account: b }) => ({
        auction: b.auction, qty: Number(b.qty.toString()) / 10 ** STOCK_DECIMALS, price: Number(b.price.toString()) / 1e6,
        fill: Number(b.fill.toString()) / 10 ** STOCK_DECIMALS, revealed: b.revealed, claimed: b.claimed,
        bond: Number(b.bond.toString()) / 1e6, sealed: !b.maxNotional.isZero(),
      }));
    },
  });
}

export function AuctionsView() {
  const { publicKey } = useWallet();
  const { markets, error } = useApp();
  const program = useProgram();
  const now = useNow(1000);
  const list = useAuctions(markets);
  const auctions = list.data ?? [];
  const mine = useMyBids().data ?? [];
  const inv = useInventory(markets).data;
  const kappa = useRiskConfig().data?.kappa ?? 0;
  const [saved, setSaved] = useState<Saved[]>([]);
  useEffect(() => setSaved(publicKey ? loadSaved(publicKey.toBase58()) : []), [publicKey]);

  const owner = () => {
    if (!publicKey) throw new Error("Connect a wallet first.");
    return publicKey;
  };
  const bidAccounts = (a: AuctionRow) => ({
    bidder: owner(), config: configPda(), market: a.market.key, auction: a.key, bid: bidPda(a.key, owner()),
    bidderUsdc: getAssociatedTokenAddressSync(USDC_MINT, owner()), usdcVault: usdcVaultPda(),
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  });
  const myBid = (a: AuctionRow) => mine.find((b) => b.auction.equals(a.key));

  const commitLot = auctions.find((a) => a.kind === AUCTION_KIND.REOPEN && phaseOf(a, now) === "Commit" && !myBid(a));
  const revealLot = auctions.find((a) => phaseOf(a, now) === "Reveal" && myBid(a) && !myBid(a)!.revealed);
  const openLot = auctions.find((a) => a.kind !== AUCTION_KIND.REOPEN && phaseOf(a, now) === "Open" && !myBid(a));
  const claimable = auctions.filter((a) => a.phase === 4 && myBid(a) && !myBid(a)!.claimed);
  const gdaLot = inv?.rows.find((r) => r.gda.active && r.gda.sold < r.gda.qty && r.market.state === "Open");
  const gdaQuoteFor = (r: InventoryRow, qty: number) =>
    Number(gdaQuote(r.gda.raw, BigInt(Math.round(qty * 10 ** STOCK_DECIMALS)), Math.floor(now), new BN(Math.round(r.market.price * 1e6)), STOCK_DECIMALS, r.nav ? KAPPA_NAV : kappa)) / 1e6;
  const label = (a: AuctionRow) => `${ticker(a.market.symbol)} #${a.id}`;
  const qtyPrice = (a: AuctionRow) => [
    { key: "q", unit: ticker(a.market.symbol), label: "Quantity", quick: [{ label: "Whole lot", value: String(a.lot) }] },
    { key: "p", unit: `${LOAN_SYMBOL} each`, label: "Your price", initial: (a.market.price * 0.99).toFixed(2), quick: [{ label: "Reserve", value: a.reserve.toFixed(6) }] },
  ];

  const specs: Spec[] = [];
  if (commitLot) {
    specs.push({
      icon: "gavel",
      title: "Commit bid",
      sub: "Sealed, uniform price",
      amount: `${num(commitLot.lot)} ${ticker(commitLot.market.symbol)}`,
      dialog: {
        title: `Commit a sealed bid · ${label(commitLot)}`,
        description: "Your price stays hidden until the reveal window. You post a 10% bond now; a bid you don't reveal, or that's below the reserve, forfeits it to the Underwriter Pool.",
        fields: qtyPrice(commitLot),
        preview: (v) => [
          ["Reserve", usd(commitLot.reserve)],
          ["Notional", usd((v.q ?? 0) * (v.p ?? 0))],
          ["Bond now (10%)", usd((v.q ?? 0) * (v.p ?? 0) * 0.1)],
          ["Reveal", `${et(commitLot.deadlines[2])} → ${et(commitLot.deadlines[3])}`],
        ],
        confirm: "Commit",
        hint: "The secret needed to reveal is kept on this device. Don't clear this browser's storage before you reveal.",
        plan: async (v) => {
          const qty = BigInt(units(v.q, STOCK_DECIMALS).toString());
          const price = BigInt(units(v.p, USDC_DECIMALS, "a price").toString());
          const salt = crypto.getRandomValues(new Uint8Array(32));
          const notional = (qty * price) / 10n ** BigInt(STOCK_DECIMALS);
          const next = [...saved.filter((s) => s.auction !== commitLot.key.toBase58()), { auction: commitLot.key.toBase58(), qty: qty.toString(), price: price.toString(), salt: Array.from(salt) }];
          storeSaved(owner().toBase58(), next);
          setSaved(next);
          return [
            await program.methods
              .commitBid(bidCommitment(commitLot.key, owner(), qty, price, salt), new BN((notional + 1n).toString()))
              .accountsPartial(bidAccounts(commitLot))
              .instruction(),
          ];
        },
        activity: (v) => ({ icon: "gavel", title: `Sealed bid on ${label(commitLot)}`, amount: `${v.q} @ ${usd(Number(v.p))}`, kind: "auction" }),
      },
    });
  }
  if (revealLot) {
    const s = saved.find((x) => x.auction === revealLot.key.toBase58());
    specs.push({
      icon: "clock",
      title: "Reveal",
      sub: "After the commit window",
      amount: s ? usd(Number(s.price) / 1e6) : "Secret missing",
      dialog: {
        title: `Reveal your bid · ${label(revealLot)}`,
        description: "Opens your sealed bid and escrows the rest of quantity × price (your bond counts toward it).",
        preview: () => [
          ["Quantity", s ? num(Number(s.qty) / 10 ** STOCK_DECIMALS) : "—"],
          ["Price", s ? usd(Number(s.price) / 1e6) : "—"],
          ["Clears", et(revealLot.deadlines[3])],
        ],
        confirm: "Reveal",
        blocked: s ? null : "This device doesn't have the secret for that bid.",
        plan: async () => [
          await program.methods
            .revealBid(new BN(s!.qty), new BN(s!.price), s!.salt)
            .accountsPartial(bidAccounts(revealLot))
            .instruction(),
        ],
        activity: () => ({ icon: "clock", title: `Revealed bid on ${label(revealLot)}`, amount: usd(Number(s!.price) / 1e6), kind: "auction" }),
      },
    });
  }
  if (openLot) {
    specs.push({
      icon: "gavel",
      title: "Place bid",
      sub: openLot.kind === AUCTION_KIND.INTRADAY ? "Intraday, 60 s" : openLot.kind === AUCTION_KIND.EMERGENCY ? "Extended hours, 5 min" : "Pre-close",
      amount: `${num(openLot.lot)} ${ticker(openLot.market.symbol)}`,
      dialog: {
        title: `Bid on ${label(openLot)}`,
        description: "A firm bid at or above the reserve. Everyone who fills pays the same clearing price, the last price needed to sell the lot.",
        fields: qtyPrice(openLot),
        preview: (v) => [
          ["Reserve", usd(openLot.reserve)],
          ["Escrowed now", usd((v.q ?? 0) * (v.p ?? 0))],
          ["Clears", et(openLot.deadlines[3])],
        ],
        confirm: "Place bid",
        plan: async (v) => [
          await program.methods.placeBid(units(v.q, STOCK_DECIMALS), units(v.p, USDC_DECIMALS, "a price")).accountsPartial(bidAccounts(openLot)).instruction(),
        ],
        activity: (v) => ({ icon: "gavel", title: `Bid on ${label(openLot)}`, amount: `${v.q} @ ${usd(Number(v.p))}`, kind: "auction" }),
      },
    });
  }
  if (claimable.length) {
    const a = claimable[0]!;
    const b = myBid(a)!;
    specs.push({
      icon: "cash",
      title: "Claim",
      sub: "Tokens and refunds",
      amount: b.fill ? `${num(b.fill)} ${ticker(a.market.symbol)}` : "Refund",
      dialog: {
        title: `Claim ${label(a)}`,
        description: "Winners take their tokens; everyone takes back the escrow they didn't use (a forfeited bond stays with the pool).",
        preview: () => [
          ["Filled", `${num(b.fill)} ${ticker(a.market.symbol)} at ${usd(a.pStar)}`],
          ["Your price", usd(b.price)],
        ],
        confirm: "Claim",
        plan: async () => [
          await program.methods
            .claimBid()
            .accountsPartial({
              bidder: owner(), config: configPda(), market: a.market.key, auction: a.key, bid: bidPda(a.key, owner()), usdcMint: USDC_MINT,
              collateralMint: a.market.mint, vault: vaultPda(a.market.key),
              bidderCollateral: getAssociatedTokenAddressSync(a.market.mint, owner()), bidderUsdc: getAssociatedTokenAddressSync(USDC_MINT, owner()),
              usdcVault: usdcVaultPda(), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ],
        activity: () => ({ icon: "cash", title: `Claimed ${label(a)}`, amount: b.fill ? `${num(b.fill)} ${ticker(a.market.symbol)}` : "Refund", kind: "auction" }),
      },
    });
  }

  if (gdaLot) {
    const r = gdaLot;
    const left = r.gda.qty - r.gda.sold;
    specs.push({
      icon: "cash",
      title: "Buy from pool",
      sub: "Falling price, any time today",
      amount: `${num(left)} ${ticker(r.market.symbol)}`,
      dialog: {
        title: `Buy ${ticker(r.market.symbol)} from the Underwriter Pool`,
        description:
          "Tokens the pool bought at auction reserves are sold back by a gradual Dutch auction: each unit starts at 1.02× the market price and halves every 24 hours, but never sells below the reserve. Buying ahead of the release schedule costs more.",
        fields: [{ key: "q", unit: ticker(r.market.symbol), label: "Quantity", quick: [{ label: "All left", value: String(left) }] }],
        preview: (v) => {
          const c = gdaQuoteFor(r, v.q ?? 0);
          return [
            ["Cost now", usd(c, 2)],
            ["Per token", v.q ? usd(c / v.q, 2) : "—"],
            ["Market price", usd(r.market.price)],
            ["Max you pay (+1%)", usd(c * 1.01, 2)],
          ];
        },
        confirm: "Buy",
        plan: async (v) => {
          const qty = units(v.q, STOCK_DECIMALS);
          const maxCost = new BN(Math.ceil(gdaQuoteFor(r, Number(v.q ?? 0)) * 1.01 * 1e6));
          return [
            await program.methods
              .gdaBuy(qty, maxCost)
              .accountsPartial({
                buyer: owner(), config: configPda(), pool: r.pool, inventory: r.key, market: r.market.key, clock: clockPda(r.market.key),
                calendar: calendarPda(r.market.marketHours ? "XNYS" : "USBANK"), riskConfig: riskConfigPda(), collateralMint: r.market.mint,
                poolTokens: getAssociatedTokenAddressSync(r.market.mint, r.pool, true),
                buyerTokens: getAssociatedTokenAddressSync(r.market.mint, owner()), buyerUsdc: getAssociatedTokenAddressSync(USDC_MINT, owner()),
                usdcVault: usdcVaultPda(), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
              })
              .instruction(),
          ];
        },
        activity: (v) => ({ icon: "cash", title: `Bought ${ticker(r.market.symbol)} from the pool`, amount: `${v.q} ${ticker(r.market.symbol)}`, kind: "auction" }),
      },
    });
  }

  const live = auctions.filter((a) => ["Commit", "Reveal", "Open"].includes(phaseOf(a, now)));
  const head = commitLot ?? openLot ?? revealLot ?? live[0];
  const nextReopen = markets.find((m) => m.marketHours)?.clock;

  return (
    <>
      <PageHead
        title="Auctions"
        sub="Every liquidation clears in a batch at one uniform price, so being fastest earns nothing. At the reopen, bids are sealed with commit and reveal."
        right={
          saved.length ? (
            <button
              type="button"
              className="cx-chip"
              onClick={() => {
                const blob = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `finity-sealed-bids-${publicKey?.toBase58().slice(0, 8)}.json`;
                a.click();
              }}
            >
              Download bid backup
            </button>
          ) : undefined
        }
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H>{head ? `${phaseOf(head, now)}: ${label(head)}` : "Next reopen auction"}</H>
            <Row specs={specs}>
              <GradientCard
                logo={head ? tokenLogo(head.market.symbol) : null}
                tag={head ? ticker(head.market.symbol) : "REOPEN"}
                big={head ? `${num(head.lot)} ${ticker(head.market.symbol)}` : et(nextReopen?.current?.reopenAt ?? nextReopen?.nextReopenAt)}
                label={head ? `Reserve ${usd(head.reserve)}` : "Lots announced"}
                value={head ? `Clears ${et(head.deadlines[3])}` : "At the open +2:00, after the queue closes"}
                pill={<Pill>{head ? AUCTION_KIND_NAME[head.kind] : "Sealed bids"}</Pill>}
              />
            </Row>
          </section>
          <section>
            <H>Recent auctions</H>
            {list.error || error ? (
              <ErrorNote error={list.error ?? error} />
            ) : auctions.length === 0 ? (
              <Note icon="gavel">No auction has run yet. A lot appears here when a loan falls under water at a reopen or during the day.</Note>
            ) : (
              <div className="cx-table-wrap">
                <table className="cx-table">
                  <thead>
                    <tr>
                      <th>Lot</th>
                      <th>Type</th>
                      <th className="is-num">Quantity</th>
                      <th className="is-num">Reserve</th>
                      <th className="is-num">Cleared</th>
                      <th className="is-num">Pool took</th>
                      <th className="is-num">vs reserve</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auctions.map((a) => (
                      <tr key={a.key.toBase58()}>
                        <td data-label="Lot" className="is-strong">
                          {label(a)} <span style={{ color: "var(--cx-grey)", fontWeight: 400 }}>{et(a.deadlines[3])}</span>
                        </td>
                        <td data-label="Type">
                          {a.kind === AUCTION_KIND.REOPEN ? "Reopen, sealed" : a.kind === AUCTION_KIND.INTRADAY ? "Intraday, 60 s" : a.kind === AUCTION_KIND.EMERGENCY ? "Emergency, 5 min" : "Pre-close"}
                        </td>
                        <td data-label="Quantity" className="is-num">{a.lot ? num(a.lot) : `${a.positions} queued`}</td>
                        <td data-label="Reserve" className="is-num">{usd(a.reserve)}</td>
                        <td data-label="Cleared" className="is-num is-strong">{a.phase === 4 ? (a.pStar ? usd(a.pStar) : "Pool") : phaseOf(a, now)}</td>
                        <td data-label="Pool took" className="is-num">{a.phase === 4 ? num(a.qPool) : "—"}</td>
                        <td data-label="vs reserve" className="is-num">{a.pStar && a.reserve ? pct(a.pStar / a.reserve - 1, 2) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <H>Pool inventory</H>
            {!inv || (inv.rows.every((r) => r.qty === 0) && inv.redemptions.length === 0) ? (
              <Note icon="shield">
                Nothing held. When bidders leave part of a lot unsold, the Underwriter Pool buys it at the reserve; stocks are then resold here by a
                falling-price auction, and T-Bill fund tokens are redeemed with the fund.
              </Note>
            ) : (
              <div className="cx-table-wrap">
                <table className="cx-table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th className="is-num">Held</th>
                      <th className="is-num">Paid</th>
                      <th className="is-num">In NAV</th>
                      <th>Resale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.rows
                      .filter((r) => r.qty > 0)
                      .map((r) => (
                        <tr key={r.key.toBase58()}>
                          <td data-label="Token" className="is-strong">{ticker(r.market.symbol)}</td>
                          <td data-label="Held" className="is-num">{num(r.qty)}</td>
                          <td data-label="Paid" className="is-num">{usd(r.cost, 2)}</td>
                          <td data-label="In NAV" className="is-num">{usd(r.mark, 2)}</td>
                          <td data-label="Resale">
                            {r.nav
                              ? "Redeeming with the fund"
                              : r.gda.active
                                ? `${num(r.gda.sold)} of ${num(r.gda.qty)} sold · ${usd(gdaQuoteFor(r, Math.min(1, r.gda.qty - r.gda.sold)) / Math.min(1, r.gda.qty - r.gda.sold || 1), 2)} each now`
                                : "Listed at the next regular session"}
                          </td>
                        </tr>
                      ))}
                    {inv.redemptions.map((x) => (
                      <tr key={`r${x.id}`}>
                        <td data-label="Token" className="is-strong">{x.market ? ticker(x.market.symbol) : "TBILL"} redemption #{x.id}</td>
                        <td data-label="Held" className="is-num">{num(x.qty)}</td>
                        <td data-label="Paid" className="is-num">{usd(x.cost, 2)}</td>
                        <td data-label="In NAV" className="is-num">{x.claimed ? usd(x.assets, 2) : usd(x.cost, 2)}</td>
                        <td data-label="Resale">{x.claimed ? "Paid by the fund" : `Fund pays ${et(x.readyAt)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <H>Your bids</H>
            {mine.length === 0 ? (
              <Note icon="lock">Your bids are listed here. Sealed bids keep their reveal secret on this device; download a backup after committing.</Note>
            ) : (
              <KV
                rows={mine.map((b) => {
                  const a = auctions.find((x) => x.key.equals(b.auction));
                  return [
                    a ? label(a) : b.auction.toBase58().slice(0, 6),
                    <Pill key="r" tone={b.fill ? "good" : "soft"}>
                      {b.fill ? `Filled ${num(b.fill)} at ${a ? usd(a.pStar) : "p*"}` : b.revealed ? `${num(b.qty)} @ ${usd(b.price)}` : "Committed (sealed)"}
                      {b.claimed ? " · claimed" : ""}
                    </Pill>,
                  ];
                })}
              />
            )}
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Live lots" value={String(live.length)} chip={live.length ? "Bidding now" : "None right now"} />
          <div>
            <H>Reopen timeline</H>
            <KV
              rows={[
                ["0:00", "Official opening price"],
                ["0:00–2:00", "Queue under-water loans"],
                ["2:00", "Lots sized"],
                ["2:00–5:00", "Commit sealed bids + 10% bond"],
                ["5:00–7:00", "Reveal and escrow payment"],
                ["7:00", "Clear, settle, refund"],
              ]}
            />
          </div>
          <Note icon="shield">
            Bids below the reserve (97% of the open) are ignored. Any unsold part of a lot is bought by the Underwriter Pool at the
            reserve.
          </Note>
        </aside>
      </div>
    </>
  );
}
