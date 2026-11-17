/** Cluster and display helpers for the full protocol's pages (the network is never named in the UI). */

/** What the UI calls the network. */
export const CLUSTER_NAME = "Solana";
const PUBLIC_RPC = "https://api.devnet.solana.com";
/** JSON-RPC goes through this app's /api/rpc proxy (the private endpoint stays on the server), unless an explicit
 *  public endpoint is configured. Websocket subscriptions use the cluster's public endpoint. */
export const rpcUrl = () =>
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || (typeof window === "undefined" ? PUBLIC_RPC : `${window.location.origin}/api/rpc`);
export const WS_URL = process.env.NEXT_PUBLIC_SOLANA_WS_URL || "wss://api.devnet.solana.com";

export const ticker = (symbol: string) => symbol;

/** Logo of an asset or loan token in /public/tokens (test tokens use their real counterpart's logo); null = no logo. */
const LOGO: Record<string, string> = {
  AAPL: "aapl", NVDA: "nvda", TSLA: "tsla", MSFT: "msft", GOOGL: "googl", AMZN: "amzn", TBILL: "tbill", USDC: "usdc",
};
export const tokenLogo = (symbol: string): string | null => (LOGO[symbol] ? `/tokens/${LOGO[symbol]}.svg` : null);

/** The full protocol's transactions get no explorer links: the explorer would name their network. */
export const explorerTx = (_sig: string): string | null => null;

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
