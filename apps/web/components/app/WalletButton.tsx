"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { CLUSTER_NAME, shortAddress } from "@/lib/protocol";

/** The Solana wallet button, drawn in the dashboard's own style (ink pill, as on the landing page). */
export function WalletButton() {
  const { publicKey, wallet, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <span className="cx-wallet" aria-hidden style={{ visibility: "hidden" }} />;
  if (!publicKey) {
    return (
      <button type="button" className="cx-wallet" onClick={() => setVisible(true)} disabled={connecting}>
        <Icon name="lock" size={17} strokeWidth={1.9} />
        <span className="cx-wallet-long">{connecting ? "Connecting…" : "Connect wallet"}</span>
        <span className="cx-wallet-short">Connect</span>
      </button>
    );
  }
  const addr = publicKey.toBase58();
  return (
    <span className="cx-wallet-group">
      <span className="cx-wallet is-ghost" title="Your wallet signs; Finity sends each transaction to the right place.">
        {wallet?.adapter.icon ? <img src={wallet.adapter.icon} alt="" width={18} height={18} /> : <span className="cx-dot-net" />}
        <span className="cx-wallet-net">{CLUSTER_NAME}</span>
      </span>
      <button
        type="button"
        className="cx-wallet"
        title={`${addr}: click to disconnect`}
        onClick={() => {
          if (window.confirm(`Disconnect ${shortAddress(addr)}?`)) void disconnect();
        }}
      >
        <span>{shortAddress(addr)}</span>
      </button>
    </span>
  );
}
