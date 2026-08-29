import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle for a small Docker image.
  output: "standalone",
  // In a monorepo, trace workspace deps from the repo root.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // The stdio MCP servers are spawned as child processes by a path built at
  // runtime (`join(here, "..", "servers", name, "server.mjs")`), which the
  // tracer cannot follow — so without this they are simply absent from the
  // deployed bundle and every one of them fails to spawn. That includes the
  // `memory` server, i.e. every agent silently loses its memory in production
  // while working perfectly in dev. Trace them in explicitly.
  outputFileTracingIncludes: {
    "/**": [
      "../../packages/mcp/servers/**/*.mjs",
      "../../packages/mcp/sample-server/**/*.mjs",
      "../../packages/mcp/pptx-template/**/*.mjs",
    ],
  },
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
