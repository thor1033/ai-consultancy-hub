import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle for a small Docker image.
  output: "standalone",
  // In a monorepo, trace workspace deps from the repo root.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
