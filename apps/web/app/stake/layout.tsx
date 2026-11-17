import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/app/Providers";
import { StakeShell } from "@/components/app/StakeShell";
import "../app/app.css";

export const metadata: Metadata = {
  title: "Stake $FINO · Finity",
  description: "Lock $FINO for a fixed term and receive the principal plus a fixed reward at unlock.",
};

/** Stake is its own page (not inside the app dashboard): a top bar and the page, with the wallet providers. */
export default function StakeLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <StakeShell>{children}</StakeShell>
    </Providers>
  );
}
