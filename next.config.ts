import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / WASM packages that must run in Node, not be bundled.
  serverExternalPackages: ["better-sqlite3", "mupdf"],
};

export default nextConfig;
