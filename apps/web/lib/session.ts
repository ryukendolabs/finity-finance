// Server-only: wallet sessions after a Sign-In-With-Solana signature. The cookie holds wallet + expiry, signed with
// HMAC-SHA256 under a secret from FINITY_SESSION_SECRET (or one generated once into ~/.config/finity).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export const COOKIE = "cx_session";
const TTL_SECS = 7 * 24 * 3600;

let secret: string | null = null;
function key(): string {
  if (secret) return secret;
  if (process.env.FINITY_SESSION_SECRET) return (secret = process.env.FINITY_SESSION_SECRET);
  const dir = `${homedir()}/.config/finity`;
  const file = `${dir}/session_secret`;
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return (secret = readFileSync(file, "utf8").trim());
}

const mac = (v: string) => createHmac("sha256", key()).update(v).digest("base64url");

export function issue(wallet: string): { value: string; maxAge: number } {
  const v = `${wallet}.${Math.floor(Date.now() / 1000) + TTL_SECS}`;
  return { value: `${v}.${mac(v)}`, maxAge: TTL_SECS };
}

/** The signed-in wallet, or null. */
export function walletOf(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const i = cookie.lastIndexOf(".");
  if (i < 0) return null;
  const [v, sig] = [cookie.slice(0, i), cookie.slice(i + 1)];
  const want = Buffer.from(mac(v));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [wallet, exp] = v.split(".");
  return wallet && Number(exp) > Date.now() / 1000 ? wallet : null;
}

/** The sign-in message the wallet signs (human-readable, single use). */
export const signInMessage = (wallet: string, nonce: string, issued: string) =>
  `Sign in to Finity Finance\n\nThis proves you control this wallet. It sends no transaction and costs nothing.\n\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${issued}\nNetwork: Solana devnet`;
