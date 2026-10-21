import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorize, knowledgeAccessFor, type Principal } from "@ai-hub/authz";
import {
  getAgent,
  recordLocalCall,
  runsLocally,
  disabledMcpServerNames,
  type Agent,
} from "@ai-hub/db";
import { connectMcpServers, type McpServerConfig } from "@ai-hub/mcp";
import { retrieveChunks, getDocument, embedderStatus } from "@ai-hub/rag";
import { isKnownServer, resolveServer } from "@/lib/runSession";
import { registerMemoryTools, text } from "@/lib/mcp/memoryTools";

/*
 * One agent, served to the Claude Code session it was synced into.
 *
 * A local agent's model runs on someone's machine; everything the hub enforces
 * stays here. The sub-agent file holds instructions and this URL, never a
 * credential, so what an agent may reach is decided by this server on every
 * call rather than by a file anyone can edit:
 *
 *   tools      the agent's configured MCP servers, dialled by the hub with the
 *              hub's credential — "the secretary cannot write" is still a
 *              property of the PM-tool token it holds, not of a prompt
 *   memory     this agent's, and only this agent's (memoryTools.ts)
 *   knowledge  retrieved as the CALLER, narrowed to the agent's collection
 *
 * Who may connect: a principal allowed agent:run, the same permission that
 * opens an agent's memory in /agents and runs it over /api/mcp. A credential
 * BOUND to an agent narrows that to its own agent, so a token handed to one
 * sub-agent is not a key to the others.
 */

export type ResolvedAgent = { agent: Agent } | { status: 403 | 404; message: string };

export async function resolveLocalAgent(principal: Principal, slug: string): Promise<ResolvedAgent> {
  if (!(await authorize(principal, "agent:run"))) {
    return { status: 403, message: "You are not permitted to run agents." };
  }
  const agent = await getAgent(slug);
  if (!agent || !agent.enabled) return { status: 404, message: `No enabled agent "${slug}".` };
  if (!runsLocally(agent.placement)) {
    return {
      status: 404,
      message: `"${agent.name}" runs on the hub only. Set it to "Local" or "Both" to use it from Claude Code.`,
    };
  }
  if (principal.agentId && principal.agentId !== agent.id && principal.agentId !== agent.slug) {
    return { status: 403, message: `This credential is bound to another agent.` };
  }
  return { agent };
}

// ── upstream tool lists ─────────────────────────────────────────────────────
// The server is rebuilt per request (the endpoint is stateless), and Claude
// Code lists tools on every connect. Dialling the PM-tool just to learn its tool
// names each time would put a remote round trip in front of every call, so the
// LIST is cached briefly. Calls are never cached: each one dials fresh with the
// hub's credential.

interface UpstreamTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const LIST_TTL_MS = 5 * 60_000;
const listCache = new Map<string, { at: number; tools: UpstreamTool[] }>();

async function upstreamTools(config: McpServerConfig): Promise<UpstreamTool[]> {
  const hit = listCache.get(config.name);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.tools;
  const mcp = await connectMcpServers([config]);
  try {
    const tools = mcp.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.input_schema as Record<string, unknown>,
    }));
    listCache.set(config.name, { at: Date.now(), tools });
    return tools;
  } finally {
    await mcp.close();
  }
}

/**
 * An upstream tool's JSON Schema as the zod schema McpServer wants.
 *
 * The client sees it re-serialised, so it has to round-trip; a schema zod cannot
 * read becomes a loose object, which still lists the tool and still forwards the
 * arguments — the upstream server validates them either way.
 */
function schemaFrom(json: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.looseObject({});
  }
}

export async function buildAgentMcpServer(principal: Principal, agent: Agent): Promise<McpServer> {
  const server = new McpServer(
    { name: `ai-hub-agent-${agent.slug}`, version: "0.1.0" },
    {
      instructions:
        `The hub's "${agent.name}" agent: its memory, its knowledge and its tools. ` +
        "Call hub_memory_list first. Everything here is checked by the hub; a refusal " +
        "means this agent is not allowed to do it.",
    },
  );

  // Every call is logged, successes and failures alike: the hub cannot see a
  // local agent's model, so its tool calls are the only record of its work.
  const track = <A, R>(tool: string, fn: (args: A) => Promise<R>) =>
    async (args: A): Promise<R> => {
      const started = Date.now();
      let ok = false;
      try {
        const result = await fn(args);
        ok = !(result as { isError?: boolean })?.isError;
        return result;
      } finally {
        recordLocalCall({
          agentId: agent.id,
          principalId: principal.id,
          tool,
          ok,
          latencyMs: Date.now() - started,
        }).catch(() => {});
      }
    };

  // Memory, wrapped so its calls are tracked like the rest.
  registerMemoryTools(trackingProxy(server, track), agent.id);

  // Knowledge, as the caller. The agent's collection is curation and narrows
  // what is searched; it never widens what the caller may read.
  if (await authorize(principal, "rag:search")) {
    const access = await knowledgeAccessFor(principal);
    server.registerTool(
      "hub_search_knowledge",
      {
        description:
          "Search the hub's knowledge base for company context" +
          (agent.knowledgeCollection
            ? ` (this agent works from the "${agent.knowledgeCollection}" collection).`
            : ".") +
          " Returns passages with their source document and a score.",
        inputSchema: {
          query: z.string().min(1).describe("What you want to know."),
          limit: z.number().int().min(1).max(20).optional().describe("How many passages (default 5)."),
        },
      },
      track("hub_search_knowledge", async ({ query, limit }: { query: string; limit?: number }) => {
        const chunks = await retrieveChunks(
          query,
          access,
          limit ?? 5,
          agent.knowledgeCollection ? { collection: agent.knowledgeCollection } : {},
        );
        if (!chunks.length) return text(`No passages matched "${query}".`);
        const status = embedderStatus();
        return text({
          ...(status.production
            ? {}
            : { warning: `Embedder is "${status.name}" (dev fallback) — scores are not meaningful.` }),
          results: chunks.map((c) => ({
            title: c.title,
            documentId: c.documentId,
            score: Number(c.score.toFixed(4)),
            content: c.content,
          })),
        });
      }),
    );

    if (await authorize(principal, "document:read")) {
      server.registerTool(
        "hub_get_document",
        {
          description: "Read one knowledge document in full, by the id search returned.",
          inputSchema: { id: z.string().min(1).describe("Document id.") },
        },
        track("hub_get_document", async ({ id }: { id: string }) => {
          const doc = await getDocument(id, access);
          // The same answer for "missing" and "not yours", so an id cannot be
          // used to probe what exists in a collection the caller may not read.
          if (!doc || (agent.knowledgeCollection && doc.collection !== agent.knowledgeCollection)) {
            return text(`No document with id ${id}.`);
          }
          return text({
            id: doc.id,
            title: doc.title,
            collection: doc.collection,
            content: doc.chunks
              .sort((a, b) => a.chunkIndex - b.chunkIndex)
              .map((c) => c.content)
              .join("\n\n"),
          });
        }),
      );
    }
  }

  // The agent's own tool servers, dialled by the hub. `memory` is served above,
  // and a server switched off in /mcp is off here too.
  const disabled = await disabledMcpServerNames();
  const names = (agent.mcpServers ?? [])
    .map((e) => (typeof e === "string" ? e : String((e as { name?: unknown }).name ?? "")))
    .filter((n) => n && n !== "memory" && isKnownServer(n) && !disabled.has(n));

  const taken = new Set(["hub_search_knowledge", "hub_get_document"]);
  for (const name of names) {
    const config = resolveServer(name, agent.id);
    if (!config) continue;
    let tools: UpstreamTool[];
    try {
      tools = await upstreamTools(config);
    } catch (err) {
      // One unreachable server must not take the agent's memory down with it.
      console.warn(`[agent-mcp] ${agent.slug}: "${name}" unavailable:`, err);
      continue;
    }
    for (const tool of tools) {
      if (taken.has(tool.name) || tool.name.startsWith("hub_")) continue;
      taken.add(tool.name);
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: schemaFrom(tool.inputSchema) as never },
        track(tool.name, async (args: unknown) => {
          const mcp = await connectMcpServers([config]);
          try {
            const out = await mcp.execute(tool.name, args ?? {});
            return { ...text(out), isError: out.startsWith("Tool error:") };
          } finally {
            await mcp.close();
          }
        }) as never,
      );
    }
  }

  return server;
}

/**
 * The server, with registerTool wrapped so each handler goes through `track`.
 * Lets memoryTools.ts stay ignorant of logging that only this endpoint does.
 */
function trackingProxy(
  server: McpServer,
  track: <A, R>(tool: string, fn: (args: A) => Promise<R>) => (args: A) => Promise<R>,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
      return (name: string, config: unknown, handler: (args: unknown) => Promise<unknown>) =>
        (target.registerTool as (...a: unknown[]) => unknown)(name, config, track(name, handler));
    },
  });
}
