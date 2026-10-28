import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorize, knowledgeAccessFor, type Principal } from "@ai-hub/authz";
import {
  getAgent,
  recordLocalCall,
  runsLocally,
  disabledMcpServerNames,
  knowledgeScope,
  retrievalScope,
  type Agent,
} from "@ai-hub/db";
import { isRemoteServer, remoteServerForwardsIdentity, remoteServerReadOnly } from "@ai-hub/mcp";
import { retrieveChunks, getDocument, embedderStatus } from "@ai-hub/rag";
import { entryName, isKnownServer, resolveServer, unavailableServers, unavailabilityNote } from "@/lib/runSession";
import { registerMemoryTools, text } from "@/lib/mcp/memoryTools";
import { registerProxiedTools } from "@/lib/mcp/proxyTools";
import { heldText, hold, needsApproval, withReason } from "@/lib/approvals";

/*
 * One agent, served to the Claude Code session it was synced into.
 *
 * A local agent's model runs on someone's machine; everything the hub enforces
 * stays here. The sub-agent file holds instructions and this URL, never a
 * credential, so what an agent may reach is decided by this server on every
 * call rather than by a file anyone can edit:
 *
 *   tools      the agent's configured MCP servers, dialled by the hub. With
 *              the hub's own credential when the caller is a credential or a
 *              schedule; with the PERSON's token when they signed in, so what
 *              the agent does in the PM-tool is done as them. A read-only
 *              entry stays read-only either way (proxyTools.ts)
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

export async function buildAgentMcpServer(principal: Principal, agent: Agent): Promise<McpServer> {
  // A server switched off in /mcp, or one this deployment never declared, is
  // not dialled — and the sub-agent is told so in the server's instructions,
  // which Claude Code shows its model, rather than finding a tool missing.
  const disabled = await disabledMcpServerNames();
  const missing = unavailableServers((agent.mcpServers ?? []).map(entryName), disabled);
  const note = unavailabilityNote(missing);
  if (note) console.warn(`[agent-mcp] ${agent.slug}: unavailable servers — ${missing.map((m) => m.name).join(", ")}`);
  const server = new McpServer(
    { name: `ai-hub-agent-${agent.slug}`, version: "0.1.0" },
    {
      instructions:
        `The hub's "${agent.name}" agent: its memory, its knowledge and its tools. ` +
        "Call hub_memory_list first. Everything here is checked by the hub; a refusal " +
        "means this agent is not allowed to do it." +
        (note ? `\n\n${note}` : ""),
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

  // Knowledge, as the caller. The agent's scope is curation and narrows what
  // is searched; it never widens what the caller may read. An agent set to
  // read nothing is served no knowledge tools at all, so "memory and tools
  // only" means the same thing here as it does on the hub.
  const scope = knowledgeScope(agent);
  const curated = retrievalScope(scope);
  if (curated && (await authorize(principal, "rag:search"))) {
    const access = await knowledgeAccessFor(principal);
    const drawers = scope.kind === "collections" ? scope.names : null;
    server.registerTool(
      "hub_search_knowledge",
      {
        description:
          "Search the hub's knowledge base for company context" +
          (drawers ? ` (this agent works from the collections: ${drawers.map((n) => `"${n}"`).join(", ")}).` : ".") +
          " Returns passages with their source document and a score.",
        inputSchema: {
          query: z.string().min(1).describe("What you want to know."),
          collection: z
            .string()
            .optional()
            .describe(
              drawers
                ? "Narrow the search to one of this agent's collections. Omit to search all of them."
                : "Restrict the search to one collection. Omit to search everything.",
            ),
          limit: z.number().int().min(1).max(20).optional().describe("How many passages (default 5)."),
        },
      },
      track("hub_search_knowledge", async ({ query, collection, limit }: { query: string; collection?: string; limit?: number }) => {
        // A collection outside the agent's set is refused by name rather than
        // searched: the model learns the boundary instead of getting an empty
        // answer it would read as "nothing written about this".
        if (collection && drawers && !drawers.includes(collection)) {
          return text(`This agent does not work from "${collection}". Its collections: ${drawers.join(", ")}.`);
        }
        const chunks = await retrieveChunks(query, access, limit ?? 5, collection ? { collection } : curated);
        if (!chunks.length) return text(`No passages matched "${query}"${collection ? ` in "${collection}"` : ""}.`);
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
          if (!doc || (drawers && !drawers.includes(doc.collection ?? ""))) {
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
  const entries = (agent.mcpServers ?? [])
    .map((entry) => ({ entry, name: entryName(entry) }))
    .filter(({ name }) => name && name !== "memory" && isKnownServer(name) && !disabled.has(name));

  const bearer = principal.accessToken;
  const taken = new Set(["hub_search_knowledge", "hub_get_document"]);
  for (const { entry, name } of entries) {
    const config = resolveServer(name, agent.id, bearer, entry);
    if (!config) continue;
    await registerProxiedTools(server, {
      config,
      // Forwarding a person's token through a read-only entry: the upstream
      // would offer their writes, so the hub keeps the read-only tools alone.
      // An entry that does not forward still dials with its own token, and
      // the upstream's scope on that token does the filtering as before.
      dropWrites:
        Boolean(bearer) &&
        isRemoteServer(name) &&
        remoteServerForwardsIdentity(name) &&
        remoteServerReadOnly(name),
      taken,
      // A tool whose calls will be held asks the model for its reason line.
      present: (info) => (needsApproval(info, entry) ? withReason(info) : info),
      // Logged, and writes held for a person (lib/approvals.ts) — the local
      // agent's model is on someone's machine, but what it may change is not.
      wrap: (tool, fn, info) =>
        track(tool, async (args: unknown) => {
          if (!needsApproval(info, entry)) return fn(args);
          const proposal = await hold(info, args, { agentId: agent.id, principalId: principal.id, entries: agent.mcpServers });
          return text(heldText(proposal));
        }),
      // One unreachable server must not take the agent's memory down with it.
      onUnavailable: (err) => console.warn(`[agent-mcp] ${agent.slug}: "${name}" unavailable:`, err),
    });
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
