"use client";

import {
  V2,
  V2_PROGRAM_ID,
  createV2AccountIx,
  decodeV2Market,
  fetchV2Positions,
  v2EffectiveState,
  v2ErrorText,
  v2Ix,
  v2LimitBps,
  type V2Market,
} from "@finity/solana/v2";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ConnectFirst } from "../actions";
import { H, KV, Note, PageHead, Pill, pct, usd } from "../ui";
import { ErrorNote, Loading } from "./shared";
import { tokenLogo } from "@/lib/protocol";
import { et, until } from "@/lib/time";

/** Finity V2 markets are on Solana mainnet; the browser reaches them through this app's /api/rpc/mainnet proxy. */
const mainnetUrl = () =>
  process.env.NEXT_PUBLIC_V2_RPC_URL || (typeof window === "undefined" ? "https://api.mainnet-beta.solana.com" : `${window.location.origin}/api/rpc/mainnet`);
/** "devnet" only to rehearse (with V2_RPC_URL pointing at devnet); the page is meant for mainnet. */
const V2_CLUSTER = process.env.NEXT_PUBLIC_V2_CLUSTER === "devnet" ? "devnet" : "mainnet";
const explorer = (a: string, kind: "address" | "tx" = "address") =>
  `https://explorer.solana.com/${kind}/${a}${V2_CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;
const TONE = { open: "good", extended: "warn", closed: "soft", halted: "bad", reopen: "warn" } as const;
const ONE = 1_000_000n;
const toUnits = (s: string) => {
  const [w, f = ""] = s.split(".");
  return BigInt(w || "0") * ONE + BigInt((f + "000000").slice(0, 6) || "0");
};
const fromUnits = (n: bigint) => Number(n) / 1e6;

type Row = { symbol: string; address: PublicKey; market: V2Market };

function useV2(conn: Connection) {
  const { publicKey } = useWallet();
  const markets = useQuery({
    queryKey: ["v2-markets"],
    refetchInterval: 20_000,
    queryFn: async (): Promise<Row[]> => {
      const book = Object.entries(V2.markets[V2_CLUSTER]);
      if (!book.length) return [];
      const infos = await conn.getMultipleAccountsInfo(book.map(([, a]) => new PublicKey(a)));
      return book.flatMap(([symbol, a], i) => {
        const m = infos[i] ? decodeV2Market(infos[i]!.data) : null;
        return m ? [{ symbol, address: new PublicKey(a), market: m }] : [];
      });
    },
  });
  const positions = useQuery({
    queryKey: ["v2-positions", publicKey?.toBase58()],
    enabled: !!publicKey,
    refetchInterval: 30_000,
    queryFn: () => fetchV2Positions(conn, publicKey!),
  });
  return { markets, positions };
}

export function MainnetView() {
  const conn = useMemo(() => new Connection(mainnetUrl(), "confirmed"), []);
  const { publicKey, signTransaction } = useWallet();
  const qc = useQueryClient();
  const { markets, positions } = useV2(conn);
  const rows = markets.data ?? [];
  const [symbol, setSymbol] = useState<string>("");
  const [coll, setColl] = useState("10");
  const [debt, setDebt] = useState("0");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);
  const now = Math.floor(Date.now() / 1000);
  const sel = rows.find((r) => r.symbol === symbol) ?? rows[0];

  async function run(label: string, ixs: TransactionInstruction[], extra: Keypair[] = []) {
    if (!publicKey || !signTransaction) return;
    setBusy(label);
    setMsg(null);
    try {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      if (extra.length) tx.partialSign(...extra);
      const signed = await signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setMsg({ ok: true, text: `${label}: confirmed on mainnet.`, sig });
      await qc.invalidateQueries({ queryKey: ["v2-positions"] });
    } catch (e) {
      setMsg({ ok: false, text: v2ErrorText(e) ?? (e as Error).message ?? String(e) });
    } finally {
      setBusy(null);
    }
  }

  const open = async () => {
    if (!sel || !publicKey) return;
    const pos = Keypair.generate();
    await run("Open position", [
      await createV2AccountIx(conn, publicKey, pos.publicKey),
      v2Ix.openPosition(pos.publicKey, sel.address, publicKey, toUnits(coll), toUnits(debt)),
    ], [pos]);
  };

  const limit = sel ? v2LimitBps(sel.market, now) : null;
  const maxDebt = sel && limit !== null ? fromUnits((toUnits(coll) * sel.market.price * BigInt(limit)) / 10_000n / ONE) : 0;
  const notDeployed = markets.isSuccess && rows.length === 0;

  return (
    <>
      <PageHead
        title="Mainnet"
        sub="Finity V2: the Asset Clock and the Bell Check, live on Solana mainnet. The keeper mirrors the clock, the safe LTV and the oracle price from the full protocol on devnet."
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small><a href={explorer(V2_PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">Program ↗</a></small>}>Markets on mainnet</H>
            {markets.error ? (
              <ErrorNote error={markets.error} />
            ) : markets.isLoading ? (
              <Loading what="Reading mainnet" />
            ) : notDeployed ? (
              <Note icon="clock">Finity V2 markets are not on mainnet yet.</Note>
            ) : (
              <KV
                list
                rows={rows.map(({ symbol: s, address, market: m }) => {
                  const st = v2EffectiveState(m, now);
                  const l = v2LimitBps(m, now);
                  return [
                    <span key="k" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      {tokenLogo(s) && <img src={tokenLogo(s)!} alt="" width={20} height={20} />}
                      <a href={explorer(address.toBase58())} target="_blank" rel="noreferrer">{s}</a>
                      <Pill tone={TONE[st]}>{st}</Pill>
                    </span>,
                    <span key="v">
                      {usd(fromUnits(m.price))} · limit {l === null ? "paused" : pct(l / 1e4, 0)} · safe {pct(m.safeLtvBps / 1e4, 0)}
                      {m.nextClose > now ? ` · closes ${until(m.nextClose)}` : m.nextReopen > now ? ` · reopens ${until(m.nextReopen)}` : ""}
                    </span>,
                  ];
                })}
              />
            )}
          </section>

          <section>
            <H>Your positions on mainnet</H>
            {!publicKey ? (
              <ConnectFirst label="Connect wallet to see your mainnet positions" />
            ) : positions.isLoading ? (
              <Loading what="Reading positions" />
            ) : !positions.data?.length ? (
              <Note icon="card">No positions yet. Open one on the right.</Note>
            ) : (
              <KV
                list
                rows={positions.data.map((p) => {
                  const row = rows.find((r) => r.address.equals(p.market));
                  const value = row ? fromUnits((p.collateral * row.market.price) / ONE) : 0;
                  const ltv = value > 0 ? fromUnits(p.debt) / value : 0;
                  return [
                    <span key="k">
                      {row?.symbol ?? "?"} {p.flagged && <Pill tone="bad">Bell: above safe LTV</Pill>}
                    </span>,
                    <span key="v" style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      {fromUnits(p.collateral)} sh · debt {usd(fromUnits(p.debt))} · LTV {pct(ltv, 1)}
                      <button type="button" className="cx-chip" disabled={!!busy || !row} onClick={() => row && run("Bell check", [v2Ix.bellCheck(p.pubkey, row.address)])}>Bell check</button>
                      <button type="button" className="cx-chip" disabled={!!busy || !row} onClick={() => row && run("Repay", [v2Ix.adjustPosition(p.pubkey, row.address, publicKey, p.collateral, 0n)])}>Repay all</button>
                      <button type="button" className="cx-chip" disabled={!!busy} onClick={() => run("Close", [v2Ix.close(p.pubkey, publicKey)])}>Close (rent back)</button>
                    </span>,
                  ];
                })}
              />
            )}
          </section>
          <Note icon="lock">
            V2 positions record collateral and debt figures; no tokens move. They show the rule the full protocol enforces on devnet with real
            vaults: before the Bell (2 h before the close) the limit is max LTV; inside it, the closure-safe LTV; closed, halted or reopening, no
            new debt. Repaying always works. Opening one costs a ~0.0011 SOL deposit you get back when you close it, plus a network fee.
          </Note>
        </div>

        <aside className="cx-aside">
          <div>
            <H>Open a position</H>
            <div className="cx-field">
              <span className="cx-field-label">Market</span>
              <select value={sel?.symbol ?? ""} onChange={(e) => setSymbol(e.target.value)} disabled={!rows.length}>
                {rows.map((r) => <option key={r.symbol} value={r.symbol}>{r.symbol}</option>)}
              </select>
            </div>
            <div className="cx-field">
              <span className="cx-field-label">Collateral</span>
              <label className="cx-amount">
                <input inputMode="decimal" value={coll} onChange={(e) => setColl(e.target.value.replace(/[^\d.]/g, ""))} />
                <span>shares</span>
              </label>
            </div>
            <div className="cx-field">
              <span className="cx-field-label">Debt</span>
              <label className="cx-amount">
                <input inputMode="decimal" value={debt} onChange={(e) => setDebt(e.target.value.replace(/[^\d.]/g, ""))} />
                <span>USD</span>
              </label>
            </div>
            <KV
              rows={[
                ["Limit now", limit === null ? "No new debt (market closed)" : `${pct(limit / 1e4, 0)} → up to ${usd(maxDebt)}`],
                ["Next close", sel?.market.nextClose ? et(sel.market.nextClose) : "—"],
                ["Price age", sel?.market.priceAt ? `${now - sel.market.priceAt} s` : "—"],
              ]}
            />
            <ConnectFirst>
              <button type="button" className="cx-btn" aria-disabled={!sel || !!busy || undefined} onClick={() => !busy && open()}>
                {busy ?? "Open on mainnet"}
              </button>
            </ConnectFirst>
            {msg && (
              <p className={`cx-hint${msg.ok ? "" : " is-bad"}`} role={msg.ok ? "status" : "alert"}>
                {msg.text}{" "}
                {msg.sig && <a href={explorer(msg.sig, "tx")} target="_blank" rel="noreferrer">View ↗</a>}
              </p>
            )}
          </div>
          <Note icon="external">
            Your wallet signs a mainnet transaction here (real SOL for the fee and deposit), even if it is set to devnet for the rest of the app.
          </Note>
        </aside>
      </div>
    </>
  );
}
