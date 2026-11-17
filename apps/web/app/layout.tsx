import type { Metadata, Viewport } from "next";
import { Roboto } from "next/font/google";
import type { ReactNode } from "react";

/** The landing page's body typeface, used across the app (headings use Libre Caslon Condensed, see app/app.css). */
const roboto = Roboto({ subsets: ["latin"], variable: "--font-roboto", display: "swap" });

export const metadata: Metadata = {
  title: "Finity Finance",
  description:
    "Borrow USDC against tokenized stocks and Treasury funds. Every rule follows the market clock, so nobody is liquidated on a fake weekend price.",
  openGraph: { type: "website", title: "Finity Finance" },
  twitter: { card: "summary_large_image", title: "Finity Finance" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={roboto.variable} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
