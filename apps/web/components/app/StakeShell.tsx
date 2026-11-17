"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Ticker } from "./Ticker";
import { WalletButton } from "./WalletButton";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/stake", label: "Stake", current: true },
  { href: "https://github.com/ryukendolabs/finity-finance/tree/main/docs", label: "Docs", external: true },
];

/** The standalone page frame: the Finity sky, a top bar (brand, links, wallet) and one white panel. */
export function StakeShell({ children }: { children: ReactNode }) {
  return (
    <div className="cx-body">
      <div className="cx-solo">
        <header className="cx-solo-bar">
          <a href="/" className="cx-solo-brand" aria-label="Finity Finance home">
            <img src="/landing/mark-finity.png" alt="" />
            <span>Finity</span>
          </a>
          <nav className="cx-solo-nav" aria-label="Site">
            {LINKS.map((l) =>
              l.external ? (
                <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
                  {l.label}
                </a>
              ) : (
                <a key={l.href} href={l.href} aria-current={l.current ? "page" : undefined}>
                  {l.label}
                </a>
              ),
            )}
          </nav>
          <div className="cx-solo-right">
            <WalletButton />
            <Link href="/app" className="cx-btn is-ghost cx-solo-app">
              Launch App
            </Link>
          </div>
        </header>
        <Ticker />
        <main className="cx-solo-main">{children}</main>
        <footer className="cx-solo-foot">
          <span>© 2026 Finity Finance</span>
          <a href="/">Home</a>
          <a href="/app">App</a>
          <a href="https://github.com/ryukendolabs/finity-finance" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </footer>
      </div>
    </div>
  );
}
