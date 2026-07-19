import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle for a small Docker image.
  output: "standalone",
  // In a monorepo, trace workspace deps from the repo root.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Compile the workspace packages (shipped as TS source, no build step).
  transpilePackages: [
    "@ai-hub/agent",
    "@ai-hub/mcp",
    "@ai-hub/db",
    "@ai-hub/rag",
    "@ai-hub/authz",
  ],
};

export default nextConfig;
