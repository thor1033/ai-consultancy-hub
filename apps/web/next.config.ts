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
  // deployed bundle and fail to spawn. Today that is exactly one server,
  // `memory`, which means every agent would silently lose its memory in
  // production while working perfectly in dev. The glob stays broad so a new
  // bundled server is traced without anyone remembering to come back here.
  outputFileTracingIncludes: {
    "/**": ["../../packages/mcp/servers/**/*.mjs"],
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
