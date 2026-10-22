import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorize, knowledgeAccessFor, type Principal } from "@ai-hub/authz";
import { runAgentForPrincipal, runSkillForPrincipal, runnableAgent } from "@/lib/agentRuns";
import type { SkillParameter } from "@ai-hub/db";
import {
  putTextPart,
  resolveLargeArgs,
  LARGE_ARG_PART_CHARS,
  LARGE_ARG_RULE,
  HANDLE_PREFIX,
} from "@/lib/mcp/largeArgs";
import { getAgent, listAgents, listRunnableSkills, getRunStatus, runsOnHub } from "@ai-hub/db";
import { registerMemoryTools, text } from "@/lib/mcp/memoryTools";
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

export async function buildHubMcpServer(principal: Principal): Promise<McpServer> {
  const may = async (action: Parameters<typeof authorize>[1]) =>
    authorize(principal, action);

  // What this principal may read, resolved once per connection rather than per
  // tool call: the server is rebuilt for every request (the endpoint is
  // stateless), so "once per connection" is already as fresh as a per-call
  // lookup would be, at a quarter of the queries. Every knowledge tool below
  // narrows through it — including hub_get_document, which would otherwise be
  // the way around the filter on search.
  const access = await knowledgeAccessFor(principal);

  // Resolve the bound agent once, before the server is described, so the
  // instructions can name it and a stale binding fails closed. The lookup only
  // happens for a token that carries a binding, so a knowledge-only token pays
  // nothing for it. `getAgent` takes an id or a slug, so a token may bind by
  // either — the slug is the readable one to put in config.
  const boundAgent =
    principal.agentId && (await may("agent:run"))
      ? await getAgent(principal.agentId)
      : null;

  // Resolved once: it gates the agent and skill tools below, and whether the
  // server's instructions mention the large-argument rule at all — a viewer
  // who is offered no skill has no argument to split.
  const canRunAgents = await may("agent:run");

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
        (canRunAgents ? ` ${LARGE_ARG_RULE}` : "") +
        (boundAgent
          ? ` This token also carries the memory of the agent "${boundAgent.name}". ` +
            "Call hub_memory_list at the start of a conversation: it returns the " +
            "agent's ACTIVE memories — work in flight — and how many inactive ones " +
            "are set aside. Use hub_memory_write to record a durable fact — a " +
            "decision and its reason, a preference, a correction someone made. When " +
            "work is finished or paused, mark its memories inactive with " +
            "hub_memory_set_active; when it comes back, find them with " +
            "hub_memory_search and mark them active again. Do not store transient " +
            "detail you can look up again with another tool."
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
        const chunks = await retrieveChunks(
          query,
          access,
          limit ?? 5,
          collection ? { collection } : {},
        );
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
        const collections = await listCollections(access);
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
        const docs = await listDocuments(access);
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
        const doc = await getDocument(id, access);
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
  if (boundAgent) registerMemoryTools(server, boundAgent.id);

  // --- Agents as tools ------------------------------------------------------
  //
  // The point of the whole exercise: an agent you build in the hub shows up in
  // the client's OWN tool list, under its own name, with its own description.
  // Nobody has to learn a slug or read our docs — Claude Code, VS Code, Cursor
  // and ChatGPT all just see `hub_agent_delivery_lead` next to their other
  // tools. In org-chart terms, the employees you hired are reachable from the
  // desk you already sit at.
  //
  // Generated per request from the database, which is what makes "build it in
  // the hub, use it anywhere" true rather than aspirational: creating an agent
  // is all it takes. Clients cache tool lists, so a new agent appears on the
  // next reconnect rather than instantly.
  if (canRunAgents) {
    // A local-only agent runs in someone's Claude Code session, not here, so it
    // is offered no hub_agent_* tool — one would only ever answer with a refusal.
    const agents = (await listAgents().catch(() => [])).filter(
      (a) => a.enabled && runsOnHub(a.placement),
    );

    for (const summary of agents) {
      server.registerTool(
        toolNameForAgent(summary.slug),
        {
          description:
            (summary.description || `Ask the "${summary.name}" agent to do something.`) +
            ` Runs the hub's standing "${summary.name}" agent, which has its own ` +
            "instructions, durable memory and curated knowledge. Give it a task in " +
            "plain language, as you would brief a colleague. Long runs return a run " +
            "id to poll with hub_run_status rather than timing out.",
          inputSchema: {
            task: z
              .string()
              .min(1)
              .describe("What you want the agent to do, in plain language."),
          },
        },
        async ({ task }) => {
          const big = resolveLargeArgs(principal.id, { task });
          if ("error" in big) return text(big.error);
          return text(await describeOutcome(summary.slug, String(big.args.task)));
        },
      );
    }

    // The generic form, for scripting and for an agent created since the client
    // last connected — the per-agent tools above are the discoverable surface,
    // this is the one that never goes stale.
    server.registerTool(
      "hub_run_agent",
      {
        description:
          "Run any of the hub's standing agents by slug. Prefer the named " +
          "hub_agent_* tool when there is one; use this for an agent added since " +
          "this session connected. Call hub_list_agents to see what exists.",
        inputSchema: {
          agent: z.string().min(1).describe("The agent's slug, e.g. \"delivery-lead\"."),
          task: z.string().min(1).describe("What you want the agent to do."),
        },
      },
      async ({ agent, task }) => {
        const big = resolveLargeArgs(principal.id, { task });
        if ("error" in big) return text(big.error);
        return text(await describeOutcome(agent, String(big.args.task)));
      },
    );

    server.registerTool(
      "hub_list_agents",
      {
        description:
          "List the hub's standing agents — the ones you can ask to do work, with " +
          "what each is for.",
        inputSchema: {},
      },
      async () => {
        if (!agents.length) return text("No agents are defined in the hub yet.");
        return text(
          agents.map((a) => ({
            slug: a.slug,
            name: a.name,
            description: a.description,
            tool: toolNameForAgent(a.slug),
            remembers: a.memoryCount,
          })),
        );
      },
    );

    // --- Large arguments ----------------------------------------------------
    //
    // A tool call is written out by the calling model, token by token, inside
    // one turn — so a 90KB transcript cannot arrive as one argument however
    // much the hub is willing to accept. This is the way round it, and it is
    // one rule for every string argument of every tool below (see largeArgs.ts
    // for why equal parts rather than "split in two").
    server.registerTool(
      "hub_put_text",
      {
        description:
          "Upload a value too large for one tool call, in parts. " +
          LARGE_ARG_RULE +
          " Call once per part with the same handle (omit it on the first call; " +
          "the result gives you the handle for the rest). Parts may be sent in any " +
          "order. The result says when the upload is complete; only then pass " +
          `"${HANDLE_PREFIX}<handle>" to a hub_skill_* or hub_agent_* tool, which ` +
          "receives the whole text. Uploads are kept for an hour.",
        inputSchema: {
          handle: z
            .string()
            .optional()
            .describe("The handle returned by the first call. Omit on the first part."),
          part: z.number().int().min(1).describe("1-based number of this part."),
          parts: z.number().int().min(1).describe("How many parts the value was split into."),
          text: z
            .string()
            .describe(`This part's text, at most ${LARGE_ARG_PART_CHARS} characters.`),
        },
      },
      async ({ handle, part, parts, text: body }) => {
        const result = putTextPart(principal.id, { handle, part, parts, text: body });
        if ("error" in result) return text(result.error);
        return text({
          ...result,
          ...(result.complete
            ? { use: `${HANDLE_PREFIX}${result.handle}` }
            : { next: `Send part${result.missing && result.missing.length > 1 ? "s" : ""} ${result.missing?.join(", ")} with handle "${result.handle}".` }),
        });
      },
    );

    // --- Skills: an agent's expertise, as tools with real arguments ---------
    //
    // The step up from hub_agent_*. That tool is "ask the delivery lead
    // something", which still needs the caller to know what to ask for. A skill
    // is the task itself — `hub_skill_weekly_client_deck({ client, week })` —
    // so the work an expert did once becomes something anyone can invoke from
    // their own editor without being told how. That is skillification in the
    // shape that fits a tool list, rather than a saved transcript nobody reruns.
    const skills = (await listRunnableSkills().catch(() => [])).filter((sk) =>
      runsOnHub(sk.agentPlacement),
    );
    for (const skill of skills) {
      server.registerTool(
        toolNameForSkill(skill.slug),
        {
          description:
            (skill.description || `Run the "${skill.name}" workflow.`) +
            ` Carried out by the hub's "${skill.agentName}" agent, using its ` +
            "instructions, memory and curated knowledge. Long runs return a run id " +
            "to poll with hub_run_status. A string argument longer than " +
            `${LARGE_ARG_PART_CHARS} characters goes through hub_put_text first; pass ` +
            "the handle it returns in place of the value.",
          inputSchema: schemaForParameters(skill.parameters ?? []),
        },
        async (args) => {
          // Handles become their text here, before the template is filled, so
          // the skill is written as if the value had arrived inline.
          const big = resolveLargeArgs(principal.id, (args ?? {}) as Record<string, unknown>);
          if ("error" in big) return text(big.error);
          const outcome = await runSkillForPrincipal({
            skillRef: skill.slug,
            args: big.args,
            principal,
          });
          return text(renderOutcome(outcome, skill.name));
        },
      );
    }

    server.registerTool(
      "hub_list_skills",
      {
        description:
          "List the hub's packaged workflows — named tasks its agents can carry " +
          "out, with the arguments each one takes.",
        inputSchema: {},
      },
      async () => {
        if (!skills.length) {
          return text(
            "No skills are defined yet. Use hub_list_agents to see which agents you can ask directly.",
          );
        }
        return text(
          skills.map((sk) => ({
            slug: sk.slug,
            name: sk.name,
            description: sk.description,
            tool: toolNameForSkill(sk.slug),
            performedBy: sk.agentName,
            parameters: (sk.parameters ?? []).map((p) => ({
              name: p.name,
              description: p.description,
              required: Boolean(p.required),
              ...(p.options?.length ? { options: p.options } : {}),
            })),
          })),
        );
      },
    );

    server.registerTool(
      "hub_run_status",
      {
        description:
          "Check a run that did not finish inside its tool call. Returns the " +
          "agent's output once it is done. Poll every few seconds rather than in " +
          "a tight loop — a real run takes minutes.",
        inputSchema: {
          runId: z.string().min(1).describe("The run id returned when the run was started."),
        },
      },
      async ({ runId }) => {
        // Scoped to the principal that started it: a run id is a bearer of its
        // own output, so someone else's id must not resolve here.
        const run = await getRunStatus(runId, principal.id);
        if (!run) return text(`No run ${runId} belongs to you.`);
        if (run.status === "running") {
          return text({
            status: "running",
            startedAt: run.startedAt,
            hint: "Still working. Check again in a few seconds.",
          });
        }
        if (run.status === "failed") {
          return text({ status: "failed", error: run.error ?? "The run failed." });
        }
        return text({
          status: run.status,
          output: run.output,
          toolsUsed: run.toolsUsed,
          finishedAt: run.finishedAt,
        });
      },
    );
  }

  return server;

  async function describeOutcome(agentRef: string, task: string) {
    const outcome = await runAgentForPrincipal({ agentRef, prompt: task, principal });
    return renderOutcome(outcome, agentRef);
  }
}

function renderOutcome(
  outcome: Awaited<ReturnType<typeof runAgentForPrincipal>>,
  label: string,
) {
  if (outcome.kind === "error") return `Could not run it: ${outcome.message}`;
  if (outcome.kind === "running") {
    return {
      status: "running",
      runId: outcome.runId,
      running: label,
      // Said explicitly because the model has to be told what to do next —
      // otherwise it reports a timeout to the user and stops.
      next: `This is taking more than a moment. Call hub_run_status with runId "${outcome.runId}" in a few seconds to collect the result. The run is still going.`,
    };
  }
  return {
    status: "done",
    runId: outcome.runId,
    output: outcome.output,
    ...(outcome.toolsUsed.length ? { toolsUsed: outcome.toolsUsed } : {}),
    ...(outcome.sources ? { knowledgeSources: outcome.sources } : {}),
  };
}

/**
 * A skill's declared parameters, as the tool schema a client sees.
 *
 * This is the whole point of skills over a free-text task: the calling model is
 * told what the workflow needs — names, descriptions, which are required, which
 * are a fixed set of options — so it can gather them from the user or fill them
 * from context, instead of guessing at a sentence. An enum becomes a real enum,
 * so an invalid value is refused by the client before it costs a run.
 */
function schemaForParameters(parameters: SkillParameter[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of parameters) {
    // A name that is not a legal identifier could not be a placeholder either,
    // so it is skipped rather than allowed to produce an unusable tool.
    if (!/^[a-zA-Z0-9_]+$/.test(p.name)) continue;

    let field: z.ZodTypeAny;
    if (p.options?.length) {
      field = z.enum(p.options as [string, ...string[]]);
    } else if (p.type === "number") {
      field = z.number();
    } else if (p.type === "boolean") {
      field = z.boolean();
    } else {
      field = z.string().min(1);
    }

    field = field.describe(p.description || p.name);
    shape[p.name] = p.required ? field : field.optional();
  }
  return shape;
}

/**
 * `delivery-lead` becomes `hub_agent_delivery_lead`.
 *
 * Hyphens are legal in a slug and awkward in a tool name, and the prefix keeps
 * the hub's tools grouped in a client's list next to somebody else's. Anything
 * a slug can hold that a tool name cannot is folded to an underscore, so a slug
 * is never rejected for being unrepresentable.
 */
export function toolNameForAgent(slug: string): string {
  return `hub_agent_${slug.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}`;
}

/** `weekly-client-deck` becomes `hub_skill_weekly_client_deck`. */
export function toolNameForSkill(slug: string): string {
  return `hub_skill_${slug.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}`;
}
