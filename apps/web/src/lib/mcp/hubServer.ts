import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorize, type Principal } from "@ai-hub/authz";
import {
  getAgent,
  listMemories,
  rememberMemory,
  forgetMemory,
  searchMemories,
} from "@ai-hub/db";
import {
  retrieveChunks,
  listCollections,
  listDocuments,
  getDocument,
  embedderStatus,
} from "@ai-hub/rag";

/*
 * The hub, exposed to an outside MCP client — Claude Code, Claude Desktop, or
 * anything else that speaks Streamable HTTP.
 *
 * This is the mirror image of what the hub already does as a *client* of
 * PM-tool: the same wire protocol, pointed the other way. The hub's own tools
 * (RAG today, memory and skills next) become tools in someone else's session.
 *
 * Authorization is by construction, not by check: each tool is registered only
 * if the token's principal is allowed the action behind it. A read-only token
 * is never offered a tool it would be refused, which is a better answer than a
 * tool that exists and always errors — the model can see the difference.
 *
 * The memory tools extend that rule to *scope*. They appear only when the token
 * itself names an agent, and they operate on that agent alone — no tool takes an
 * agent id. This mirrors the stdio memory server, which reads HUB_AGENT_ID from
 * its environment and refuses to start without it: an agent id passed as an
 * argument is an agent id a model can change, and with several clients on one
 * hub that is a cross-client read, not a demo bug.
 */

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

export async function buildHubMcpServer(principal: Principal): Promise<McpServer> {
  const may = async (action: Parameters<typeof authorize>[1]) =>
    authorize(principal, action);

  // Resolve the bound agent once, before the server is described, so the
  // instructions can name it and a stale binding fails closed. The lookup only
  // happens for a token that carries a binding, so a knowledge-only token pays
  // nothing for it. `getAgent` takes an id or a slug, so a token may bind by
  // either — the slug is the readable one to put in config.
  const boundAgent =
    principal.agentId && (await may("agent:run"))
      ? await getAgent(principal.agentId)
      : null;

  const server = new McpServer(
    { name: "ai-hub", version: "0.1.0" },
    {
      instructions:
        "The AI Hub: the organisation's curated knowledge base and its packaged " +
        "workflows. Use hub_search_knowledge before answering questions about " +
        "internal projects, decisions, or business context — it retrieves from " +
        "indexed company documents that are not in your training data and not in " +
        "this repository. Prefer it over guessing, and cite the document titles " +
        "it returns." +
        (boundAgent
          ? ` This token also carries the memory of the agent "${boundAgent.name}". ` +
            "Call hub_memory_list at the start of a conversation to recall what it " +
            "already knows, and hub_memory_write to record a durable fact — a " +
            "decision and its reason, a preference, a correction someone made. Do " +
            "not store transient detail you can look up again with another tool."
          : ""),
    },
  );

  if (await may("rag:search")) {
    server.registerTool(
      "hub_search_knowledge",
      {
        description:
          "Semantic search over the hub's indexed knowledge base. Returns the " +
          "most relevant passages with their source document and a similarity " +
          "score. Use this for company context — projects, decisions, glossaries, " +
          "business cases — not for code in the current repository.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .describe("What you want to know, phrased as a question or topic."),
          collection: z
            .string()
            .optional()
            .describe(
              "Restrict the search to one curated collection. Omit to search everything.",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("How many passages to return (default 5, max 20)."),
        },
      },
      async ({ query, collection, limit }) => {
        const chunks = await retrieveChunks(query, limit ?? 5, collection ? { collection } : {});
        const status = embedderStatus();
        if (!chunks.length) {
          return text(
            `No passages matched "${query}"${collection ? ` in collection "${collection}"` : ""}.`,
          );
        }
        return text({
          // Surfaced rather than logged: without a Voyage key the hub falls back
          // to a hash embedder whose scores are meaningless. It retrieves happily
          // and returns nonsense, so the caller has to be told.
          ...(status.production ? {} : { warning: `Embedder is "${status.name}" (dev fallback) — these results are not semantically meaningful.` }),
          results: chunks.map((c) => ({
            title: c.title,
            documentId: c.documentId,
            score: Number(c.score.toFixed(4)),
            content: c.content,
          })),
        });
      },
    );
  }

  if (await may("document:read")) {
    server.registerTool(
      "hub_list_collections",
      {
        description:
          "List the curated knowledge collections available to scope a search to.",
        inputSchema: {},
      },
      async () => {
        const collections = await listCollections();
        return collections.length
          ? text(collections)
          : text("No collections defined — everything sits in the default set.");
      },
    );

    server.registerTool(
      "hub_list_documents",
      {
        description:
          "List the documents indexed in the hub's knowledge base, with a preview " +
          "of each. Use this to see what the hub knows about before searching.",
        inputSchema: {
          collection: z
            .string()
            .optional()
            .describe("Only list documents in this collection."),
        },
      },
      async ({ collection }) => {
        const docs = await listDocuments();
        const scoped = collection ? docs.filter((d) => d.collection === collection) : docs;
        if (!scoped.length) {
          return text(
            collection
              ? `No documents in collection "${collection}".`
              : "The knowledge base is empty.",
          );
        }
        return text(
          scoped.map((d) => ({
            id: d.id,
            title: d.title,
            collection: d.collection,
            sourceType: d.sourceType,
            chunks: d.chunkCount,
            preview: d.preview,
          })),
        );
      },
    );

    server.registerTool(
      "hub_get_document",
      {
        description:
          "Read one indexed document in full, by id. Use after hub_search_knowledge " +
          "when a passage looks relevant and you need the surrounding context.",
        inputSchema: {
          id: z.string().min(1).describe("Document id, as returned by search or list."),
        },
      },
      async ({ id }) => {
        const doc = await getDocument(id);
        if (!doc) return text(`No document with id ${id}.`);
        return text({
          id: doc.id,
          title: doc.title,
          collection: doc.collection,
          sourceType: doc.sourceType,
          source: doc.source,
          content: doc.chunks
            .sort((a, b) => a.chunkIndex - b.chunkIndex)
            .map((c) => c.content)
            .join("\n\n"),
        });
      },
    );
  }

  // Memory: gated on the token naming an agent that exists, not on a role alone.
  // `boundAgent` is already null unless the principal may agent:run, so a viewer
  // token with a binding gets nothing.
  if (boundAgent) {
    const agentId = boundAgent.id;

    server.registerTool(
      "hub_memory_list",
      {
        description:
          "List everything you remember, most recently updated first. Call this " +
          "at the start of a conversation.",
        inputSchema: {},
      },
      async () => {
        const rows = await listMemories(agentId);
        if (!rows.length) return text("You have no memories yet.");
        return text(rows.map((m) => ({ key: m.key, content: m.content, updatedAt: m.updatedAt })));
      },
    );

    server.registerTool(
      "hub_memory_search",
      {
        description: "Search your memories by keyword, matching the key or the content.",
        inputSchema: {
          query: z.string().min(1).describe("Keyword or phrase to look for."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("How many memories to return (default 20)."),
        },
      },
      async ({ query, limit }) => {
        const rows = await searchMemories(agentId, query, limit ?? 20);
        if (!rows.length) return text(`No memories matched "${query}".`);
        return text(rows.map((m) => ({ key: m.key, content: m.content, updatedAt: m.updatedAt })));
      },
    );

    server.registerTool(
      "hub_memory_write",
      {
        description:
          "Record a durable fact under a short key. Writing an existing key " +
          "replaces it, so correcting yourself does not leave two contradictory " +
          "memories.",
        inputSchema: {
          key: z
            .string()
            .min(1)
            .describe("A short stable name for this fact, e.g. \"weekly-review-day\"."),
          content: z.string().min(1).describe("The fact, written so it reads on its own later."),
        },
      },
      async ({ key, content }) => {
        const saved = await rememberMemory(agentId, key, content);
        return text({ saved: saved.key, content: saved.content, updatedAt: saved.updatedAt });
      },
    );

    server.registerTool(
      "hub_memory_forget",
      {
        description: "Forget the fact stored under a key, when it is wrong or no longer true.",
        inputSchema: {
          key: z.string().min(1).describe("The key to forget."),
        },
      },
      async ({ key }) => {
        const gone = await forgetMemory(agentId, key);
        return text(gone ? `Forgot "${key}".` : `Nothing was stored under "${key}".`);
      },
    );
  }

  return server;
}
