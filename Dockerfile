# syntax=docker/dockerfile:1

# --- deps: install workspace dependencies ---
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/rag/package.json ./packages/rag/package.json
COPY packages/authz/package.json ./packages/authz/package.json
RUN npm ci

# --- proddeps: runtime dependencies for the spawned MCP servers ---
# The stdio servers are plain `node server.mjs` child processes, not part of the
# Next module graph, so the tracer never sees their imports and the standalone
# bundle ships the files without @modelcontextprotocol/sdk, postgres or zod
# beside them. Installed from the same lockfile so these match what was built.
FROM node:22-alpine AS proddeps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/rag/package.json ./packages/rag/package.json
COPY packages/authz/package.json ./packages/authz/package.json
# Scoped to the mcp workspace: the servers need the MCP SDK, postgres and zod
# (and fflate + unpdf, for the teams server reading Office files and PDFs), not
# next and react. Still resolved from the root lockfile, so the versions match
# the ones the app was built against. ~70MB instead of ~530MB.
RUN npm ci --omit=dev --workspace=@ai-hub/mcp --include-workspace-root=false

# --- builder: build the Next.js standalone output ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Every seeded agent's definition is checked before anything is built: a
# skill template with a placeholder no argument fills, a Secretary given a
# server that switches the approval gate off. A failing check fails the build,
# so a broken definition never reaches the release that would apply it.
RUN npm run seeds:check --workspace=@ai-hub/db
RUN npm run build --workspace=web

# --- runner: minimal image running the standalone server ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Standalone output (traced from the monorepo root) preserves the apps/web path.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Resolvable by Node's upward walk from packages/mcp/servers/<name>/server.mjs,
# and deliberately NOT merged into /app/node_modules — that one belongs to the
# standalone server and is exactly what the tracer decided it needs.
COPY --from=proddeps /app/node_modules ./packages/mcp/node_modules

# The migration, for fly.toml's release_command. It needs only `postgres`,
# which the standalone tracer bundled into the server rather than keeping as a
# package, so it is borrowed from the MCP servers' node_modules: an ES module
# resolves imports by walking up from its own file, never from NODE_PATH, so
# the link has to sit beside the script.
COPY packages/db/migrate.mjs packages/db/schema.sql packages/db/release.mjs packages/db/release-seeds.mjs ./packages/db/
# The seeded agents and the store they are written through, as TypeScript:
# release-seeds.mjs runs them with --experimental-transform-types. They import
# nothing but each other and `postgres`, which the link below provides.
COPY packages/db/src ./packages/db/src
RUN ln -s /app/packages/mcp/node_modules /app/packages/db/node_modules

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
