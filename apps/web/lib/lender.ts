import { PublicKey } from "@solana/web3.js";

/** The lender's wallet (server only, from LEND_LENDER). Never sent to the browser: routes only answer whether a
 *  given wallet is it. */
export function lenderWallet(): PublicKey | null {
  const raw = process.env.LEND_LENDER?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}
