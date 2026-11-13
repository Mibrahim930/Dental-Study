import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / WASM packages that must run in Node, not be bundled.
  serverExternalPackages: ["better-sqlite3", "mupdf"],
  // Development only: Next's "N" badge is turned off (it covered the report button; it never shows on the live site).
  devIndicators: false,
  // The app never uses next/image; turning the optimizer off closes /_next/image, which had security advisories.
  images: { unoptimized: true },
  // Basic hardening for every page: no framing by other sites, no MIME sniffing, no full URLs leaked to other sites.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  experimental: {
    // Lecture PDFs are often 10-50 MB; the default 10 MB limit truncated uploads passing through proxy.ts.
    // 125 MB is about where Railway's edge starts refusing bodies; keep in step with MAX_UPLOAD_MB (upload route, Uploader.tsx).
    proxyClientMaxBodySize: "125mb",
  },
};

export default nextConfig;
