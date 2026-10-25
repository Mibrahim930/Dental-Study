import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / WASM packages that must run in Node, not be bundled.
  serverExternalPackages: ["better-sqlite3", "mupdf"],
  // Development only: keep Next's "N" badge off the report button in the bottom-left corner.
  devIndicators: { position: "bottom-right" },
  experimental: {
    // Lecture PDFs are often 10-50 MB; the default 10 MB limit truncated uploads passing through proxy.ts.
    // 125 MB is about where Railway's edge starts refusing bodies; keep in step with MAX_UPLOAD_MB (upload route, Uploader.tsx).
    proxyClientMaxBodySize: "125mb",
  },
};

export default nextConfig;
