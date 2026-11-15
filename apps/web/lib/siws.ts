"use client";
/** Sign-In With Solana for the private parts of the app (alerts): one signed message, no transaction. */
import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const json = async <T,>(r: Response): Promise<T> => {
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
};

export function useSiws() {
  const { publicKey, signMessage } = useWallet();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = useQuery({
    queryKey: ["me"],
    staleTime: 60_000,
    queryFn: async () => json<{ wallet: string | null }>(await fetch("/api/auth/me")),
  });
  const wallet = publicKey?.toBase58();
  const signedIn = !!wallet && me.data?.wallet === wallet;

  const signIn = async () => {
    setError(null);
    if (!publicKey) return setError("Connect a wallet first.");
    if (!signMessage) return setError("This wallet can't sign messages; try Phantom, Solflare or Backpack.");
    setBusy(true);
    try {
      const { message } = await json<{ message: string }>(
        await fetch("/api/auth/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) }),
      );
      const sig = await signMessage(new TextEncoder().encode(message));
      await json(
        await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet, message, signature: Buffer.from(sig).toString("base64") }),
        }),
      );
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (e) {
      setError(e instanceof Error && /reject/i.test(e.message) ? "You rejected the request in your wallet." : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    await qc.invalidateQueries({ queryKey: ["me"] });
  };
  return { signedIn, busy, error, signIn, signOut };
}

export type InboxItem = { id: number; event: string; subject: string; body: string; url: string | null; createdAt: number; read: boolean };

export function useInbox(signedIn: boolean) {
  return useQuery({
    queryKey: ["inbox"],
    enabled: signedIn,
    refetchInterval: 30_000,
    queryFn: async () => json<{ items: InboxItem[]; unread: number }>(await fetch("/api/alerts")),
  });
}

export async function markRead(ids: number[] | "all") {
  await fetch("/api/alerts/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
}

// ───────────── delivery channels (email, Telegram, browser push) ─────────────

export type ChannelKind = "email" | "telegram" | "webpush";
export type Channels = { channels: { kind: ChannelKind; target: string }[]; support: Record<ChannelKind, boolean>; vapidPublicKey: string };

export function useChannels(signedIn: boolean) {
  return useQuery({ queryKey: ["channels"], enabled: signedIn, queryFn: async () => json<Channels>(await fetch("/api/channels")) });
}

export async function saveChannel(kind: ChannelKind, target: unknown) {
  await json(await fetch("/api/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, target }) }));
}

export async function deleteChannel(kind: ChannelKind) {
  await json(await fetch("/api/channels", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }));
}

/** Subscribes this browser to push with the server's VAPID key (asks for notification permission). */
export async function subscribePush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser doesn't support push notifications.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site in your browser settings.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(vapidPublicKey.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  return sub.toJSON();
}

export async function unsubscribePush() {
  const reg = await navigator.serviceWorker?.getRegistration("/sw.js");
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}
