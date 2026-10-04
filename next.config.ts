import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / WASM packages that must run in Node, not be bundled.
  serverExternalPackages: ["better-sqlite3", "mupdf"],
  experimental: {
    // Lecture PDFs are often 10-50 MB; the default 10 MB limit truncated uploads passing through proxy.ts.
    proxyClientMaxBodySize: "100mb",
  },
};

export default nextConfig;
