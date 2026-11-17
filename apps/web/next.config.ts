import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The shared Solana client (IDL, PDAs, markets) is a workspace package shipped as TypeScript source.
  transpilePackages: ["@finity/solana"],
  // The alert inbox's native SQLite binding loads at runtime on the server.
  // Alert delivery (SMTP, Web Push) runs on the server too.
  serverExternalPackages: ["better-sqlite3", "nodemailer", "web-push"],
  async rewrites() {
    return {
      // The marketing site is a static port of the licensed Catalis Webflow template (public/site, with its own
      // interaction scripts), served as-is at /.
      beforeFiles: [{ source: "/", destination: "/site/index.html" }],
      afterFiles: [],
      fallback: [],
    };
  },
  turbopack: {
    // @anchor-lang/core's browser bundle keeps a dead `require("fs")` (NodeWallet.local); see lib/empty.ts.
    resolveAlias: { fs: { browser: "./lib/empty.ts" } },
  },
};

export default nextConfig;
