"use client";
/** What most pages need at once: the connected wallet, every market, the loans and lending liquidity. */
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { useMarkets, usePositions } from "./solana";

export function useApp() {
  const { publicKey, connected } = useWallet();
  const mk = useMarkets();
  const pos = usePositions(mk.markets);
  return {
    owner: publicKey,
    isConnected: connected && !!publicKey,
    ...mk,
    liquidity: mk.markets.reduce((a, m) => a + m.liquidity, 0),
    loans: pos.positions,
    loansLoading: pos.isLoading,
  };
}

/** Unix seconds, ticking every `ms` (countdowns). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
