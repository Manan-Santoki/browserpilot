import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The phone reaches the development console through this machine's
  // Tailscale address. Next otherwise blocks dev assets and Server Actions
  // from that origin even though the page itself loads.
  allowedDevOrigins: ["100.110.202.53"],
  // This app lives in a Bun workspace; without this Next guesses the root and
  // warns about it on every start.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  // The db and core packages ship TypeScript source rather than a build step,
  // so Next has to compile them alongside the app.
  transpilePackages: ["@browserpilot/db", "@browserpilot/core"],
  serverExternalPackages: ["postgres"],
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
