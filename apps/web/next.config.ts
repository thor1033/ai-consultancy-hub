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
  // Keep the scheduler out of the EDGE bundle.
  //
  // `instrumentation.ts` runs on server start and is compiled for every runtime
  // the app has — and this app has an edge runtime, because WorkOS AuthKit's
  // middleware is one. It already refuses to do anything unless
  // NEXT_RUNTIME is "nodejs", but that is a runtime check and this is a build
  // problem: webpack follows the `await import("./lib/scheduler")` while
  // bundling, pulls in agentRuns → runSession → @ai-hub/mcp → the MCP SDK's
  // stdio client → cross-spawn, and then fails to resolve `child_process`,
  // `fs` and `path`, which do not exist on the edge.
  //
  // Ignoring the request resolves it to an empty module in that one
  // compilation. Safe precisely because the guard above means the edge build
  // never calls it — the import is reachable for the bundler and unreachable
  // for the program. The Node build is untouched and still gets the real
  // scheduler.
  webpack(config, { nextRuntime, webpack }) {
    if (nextRuntime === "edge") {
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /^\.\/lib\/scheduler$/,
          contextRegExp: /apps[\\/]web[\\/]src$/,
        }),
      );
    }
    return config;
  },
};

export default nextConfig;
