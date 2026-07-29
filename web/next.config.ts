import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The db and core packages ship TypeScript source rather than a build step,
  // so Next has to compile them alongside the app.
  transpilePackages: ["@browserpilot/db", "@browserpilot/core"],
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
