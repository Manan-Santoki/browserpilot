import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives in a Bun workspace; without this Next guesses the root and
  // warns about it on every start.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  // The db and core packages ship TypeScript source rather than a build step,
  // so Next has to compile them alongside the app.
  transpilePackages: ["@browserpilot/db", "@browserpilot/core"],
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
