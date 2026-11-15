"use client";
/**
 * The actions this wallet took from this device, newest first. There is no per-wallet history service yet,
 * so "Recent activity" lists what was sent from here. Storage can be unavailable (private windows), so every
 * access is guarded. Solana addresses are case-sensitive, so keys use them as they are.
 */
import { useEffect, useState } from "react";

export type Activity = {
  icon: string;
  title: string;
  amount: string;
  /** borrow | lend | underwrite | auction | faucet */
  kind: string;
  /** Transaction signature. */
  sig: string;
  when: number;
};

const key = (address: string) => `cx-activity-${address}`;
const EVENT = "cx-activity";

export function readActivity(address: string): Activity[] {
  try {
    return JSON.parse(localStorage.getItem(key(address)) ?? "[]") as Activity[];
  } catch {
    return [];
  }
}

export function logActivity(address: string, a: Activity) {
  try {
    localStorage.setItem(key(address), JSON.stringify([a, ...readActivity(address)].slice(0, 100)));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no storage: the action still went through */
  }
}

export function useActivity(address: string | undefined, kind?: string) {
  const [items, setItems] = useState<Activity[]>([]);
  useEffect(() => {
    if (!address) return setItems([]);
    const load = () => setItems(readActivity(address).filter((a) => !kind || a.kind === kind));
    load();
    window.addEventListener(EVENT, load);
    return () => window.removeEventListener(EVENT, load);
  }, [address, kind]);
  return items;
}
