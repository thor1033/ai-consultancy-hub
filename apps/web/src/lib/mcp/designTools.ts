import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Principal } from "@ai-hub/authz";
import { ASK_SERVER, getAgent, listSkills, type McpEntry, type SkillParameter } from "@ai-hub/db";
import { saveAgentAs, saveSkillAs } from "@/lib/agentDesign";
import { knownServers } from "@/lib/runSession";
import { resolveLargeArgs } from "@/lib/mcp/largeArgs";
import { text } from "@/lib/mcp/memoryTools";
import { MODELS } from "@/app/agents/models";

/*
 * Designing agents and skills from an MCP client (docs/agent-design-tools.md).
 *
 * The person building the hub works in Claude Code as much as in the browser,
 * so the agent form is offered as tools too: read an agent whole, create one,
 * change one, and the same for skills. Every save goes through
 * lib/agentDesign.ts, the code behind the form, as the token's principal — so
 * a tool call is held to exactly the form's rules, including the ones that
 * are admin-only (where an agent runs, writing without approval).
 *
 * Registered only for a principal with agent:manage, like every hub tool: a
 * token that could not save is never offered a tool that would refuse.
 *
 * Deliberately absent: deleting an agent or a skill (a click on its page, by a
 * person looking at what they are about to lose), a mailbox per agent and
 * "writes without approval" (both are on the agent's page, the second
 * admin-only), and schedules and hand-offs, which have their own pages.
 */

const MODEL_IDS = MODELS.map((m) => m.id).filter(Boolean);

const parameterSchema = z.object({
  name: z.string().min(1).describe("Letters, digits and underscores. The prompt refers to it as {{name}}."),
  description: z.string().default("").describe("What to put here, for the person filling it in."),
  required: z.boolean().optional(),
  type: z.enum(["string", "number", "boolean"]).optional(),
  options: z.array(z.string()).optional().describe("When set, the value must be one of these."),
});

const agentFields = {
  description: z.string().optional().describe("One line: what this agent is for. Every connected client shows it in its tool list."),
  instructions: z
    .string()
    .optional()
    .describe("The agent's brief: who it is, how it works, what it must never do. Long briefs go through hub_put_text first."),
  model: z
    .string()
    .optional()
    .describe(`The model it thinks with: ${MODEL_IDS.join(", ")}, or "" for the hub's default.`),
  tools: z
    .array(z.string())
    .optional()
    .describe("Tool servers it may use, by name (see hub_list_design_options). Replaces the list; memory is separate (keepsMemory)."),
  asks: z
    .array(z.string())
    .optional()
    .describe("Slugs of agents it may ask while it runs, one level deep. Replaces the list; [] removes asking."),
  knowledgeAll: z.boolean().optional().describe("Read from every document the person running it may read."),
  knowledgeCollections: z.array(z.string()).optional().describe("Or: read only these collections. Replaces the list."),
  keepsMemory: z.boolean().optional().describe("Remember across runs (default true). False for a worker meant to start clean."),
  function: z.string().optional().describe("Its column on the org chart, e.g. Delivery."),
  owner: z.string().optional().describe("The person it reports to, on the org chart."),
  maxIterations: z.number().int().optional().describe("Most tool rounds one run may take before it stops and says so."),
  enabled: z.boolean().optional(),
};

/** The fields a tool call sends, in the form's shape, laid over an existing agent's entries. */
function serversFrom(existing: McpEntry[], tools: string[] | undefined, asks: string[] | undefined): McpEntry[] {
  const kept = new Map(existing.map((e) => [String(e.name), e]));
  const names = tools ?? existing.map((e) => String(e.name)).filter((n) => n !== ASK_SERVER && n !== "memory");
  // An entry that stays keeps its settings (a mailbox, writes allowed by an admin).
  const out: McpEntry[] = names.filter((n) => n && n !== ASK_SERVER).map((n) => kept.get(n) ?? { name: n });
  const askList = asks ?? (kept.get(ASK_SERVER) as { agents?: string[] } | undefined)?.agents ?? [];
  if (askList.length) out.push({ name: ASK_SERVER, agents: askList });
  return out;
}

export function registerDesignTools(server: McpServer, principal: Principal, baseUrl?: string): void {
  const pageOf = (slug: string) => (baseUrl ? `${baseUrl}/agents/${slug}` : `/agents/${slug}`);

  server.registerTool(
    "hub_list_design_options",
    {
      description:
        "What an agent can be built from on this hub: the tool servers it may be given, the models, and the agents it could be allowed to ask. Read this before hub_agent_create.",
      inputSchema: {},
    },
    async () =>
      text({
        toolServers: knownServers().filter((n) => n !== ASK_SERVER && n !== "memory"),
        models: MODEL_IDS,
        notes: [
          "Memory is not a tool server here: every agent remembers unless keepsMemory is false.",
          "A mailbox per agent, and letting an agent write without approval, are set on the agent's page (the second by an admin).",
          "Writes through a tool server wait for a person's approval by default.",
        ],
      }),
  );

  server.registerTool(
    "hub_agent_get",
    {
      description:
        "Read one agent whole, as its page would show it to someone who may change it: brief, model, tools, knowledge, memory setting, whom it may ask, and its skills with their prompts. Read before hub_agent_update.",
      inputSchema: { agent: z.string().min(1).describe("The agent's slug.") },
    },
    async ({ agent }) => {
      const a = await getAgent(agent);
      if (!a) return text(`There is no agent "${agent}". hub_list_agents lists them.`);
      const skills = await listSkills(a.id);
      const entries = (a.mcpServers ?? []) as McpEntry[];
      return text({
        slug: a.slug,
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        model: a.model ?? "",
        tools: entries.filter((e) => e.name !== ASK_SERVER).map((e) => e.name),
        asks: (entries.find((e) => e.name === ASK_SERVER) as { agents?: string[] } | undefined)?.agents ?? [],
        knowledgeAll: a.knowledgeAll,
        knowledgeCollections: a.knowledgeCollections,
        keepsMemory: a.keepsMemory,
        function: a.functionName,
        owner: a.owner,
        maxIterations: a.maxIterations,
        enabled: a.enabled,
        placement: a.placement,
        page: pageOf(a.slug),
        skills: skills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          prompt: s.promptTemplate,
          parameters: s.parameters,
          enabled: s.enabled,
        })),
      });
    },
  );

  server.registerTool(
    "hub_agent_create",
    {
      description:
        "Create a standing agent in the hub — the same as the New agent form, with the same rules. It runs on the hub, " +
        "remembers by default, and every write it makes through a tool server waits for a person's approval. " +
        "Call hub_list_design_options first for the tool servers and models this hub has.",
      inputSchema: {
        name: z.string().min(1).describe("Its name, e.g. \"Contracts reviewer\". The slug is made from it."),
        ...agentFields,
      },
    },
    async (args) => {
      const big = resolveLargeArgs(principal.id, { instructions: args.instructions ?? "" });
      if ("error" in big) return text(big.error);
      const out = await saveAgentAs(principal, null, {
        slug: args.name,
        name: args.name,
        description: args.description ?? "",
        instructions: String(big.args.instructions ?? ""),
        model: args.model ?? "",
        mcpServers: serversFrom([], args.tools ?? [], args.asks ?? []),
        knowledgeAll: args.knowledgeAll ?? false,
        knowledgeCollections: args.knowledgeCollections ?? [],
        keepsMemory: args.keepsMemory ?? true,
        functionName: args.function ?? "",
        owner: args.owner ?? "",
        maxIterations: args.maxIterations ?? null,
        enabled: args.enabled ?? true,
      });
      if ("error" in out) return text(`Not created: ${out.error}`);
      const dropped = droppedTools(args.tools, await getAgent(out.id));
      return text(
        [
          `Created "${args.name}" (slug ${out.slug}).`,
          dropped.length ? `Left out, because this hub has no tool server by that name: ${dropped.join(", ")}.` : null,
          `Run it now with hub_run_agent (agent "${out.slug}"); its own hub_agent_* tool appears when your client reconnects.`,
          `Its page: ${pageOf(out.slug)}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "hub_agent_update",
    {
      description:
        "Change an agent. Only the fields you send change; lists you send (tools, asks, knowledgeCollections) replace the agent's list. " +
        "Read it first with hub_agent_get. Same rules as the agent's Settings page.",
      inputSchema: {
        agent: z.string().min(1).describe("The agent's slug."),
        name: z.string().min(1).optional().describe("A new display name. The slug does not change."),
        ...agentFields,
      },
    },
    async (args) => {
      const a = await getAgent(args.agent);
      if (!a) return text(`There is no agent "${args.agent}". hub_list_agents lists them.`);
      const big = resolveLargeArgs(principal.id, args.instructions === undefined ? {} : { instructions: args.instructions });
      if ("error" in big) return text(big.error);
      const out = await saveAgentAs(principal, a.id, {
        slug: a.slug,
        name: args.name ?? a.name,
        description: args.description ?? a.description,
        instructions: args.instructions === undefined ? a.instructions : String(big.args.instructions),
        model: args.model ?? a.model ?? "",
        effort: a.effort,
        mcpServers: serversFrom((a.mcpServers ?? []) as McpEntry[], args.tools, args.asks),
        knowledgeAll: args.knowledgeAll ?? a.knowledgeAll,
        knowledgeCollections: args.knowledgeCollections ?? a.knowledgeCollections,
        keepsMemory: args.keepsMemory ?? a.keepsMemory,
        functionName: args.function ?? a.functionName,
        owner: args.owner ?? a.owner,
        maxIterations: args.maxIterations === undefined ? a.maxIterations : args.maxIterations,
        enabled: args.enabled ?? a.enabled,
        placement: a.placement,
      });
      if ("error" in out) return text(`Not changed: ${out.error}`);
      const dropped = droppedTools(args.tools, await getAgent(out.id));
      return text(
        [
          `Saved "${args.name ?? a.name}".`,
          dropped.length ? `Left out, because this hub has no tool server by that name: ${dropped.join(", ")}.` : null,
          `Its page: ${pageOf(out.slug)}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "hub_skill_create",
    {
      description:
        "Give an agent a skill: a named task with a prompt and the blanks a person fills in. It appears as a form with a Run " +
        "button on the agent's page, and as a hub_skill_* tool in every connected client. The prompt refers to each parameter as {{name}}.",
      inputSchema: {
        agent: z.string().min(1).describe("The slug of the agent that carries it out."),
        name: z.string().min(1).describe("What a person sees, e.g. \"Review a contract\"."),
        slug: z.string().optional().describe("Lowercase letters, digits and hyphens; made from the name if omitted. Becomes hub_skill_<slug>."),
        description: z.string().default("").describe("One line: what it produces."),
        prompt: z.string().min(1).describe("What the agent is asked to do, with {{parameter}} blanks. Long prompts go through hub_put_text first."),
        parameters: z.array(parameterSchema).default([]),
      },
    },
    async (args) => {
      const a = await getAgent(args.agent);
      if (!a) return text(`There is no agent "${args.agent}". hub_list_agents lists them.`);
      const big = resolveLargeArgs(principal.id, { prompt: args.prompt });
      if ("error" in big) return text(big.error);
      const slug = (args.slug?.trim() || args.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
      const out = await saveSkillAs(principal, {
        agentId: a.id,
        slug,
        name: args.name,
        description: args.description,
        promptTemplate: String(big.args.prompt),
        parameters: args.parameters as SkillParameter[],
      });
      if ("error" in out) return text(`Not created: ${out.error}`);
      return text(
        `Gave ${a.name} the skill "${args.name}" (slug ${out.saved.slug}). It has a Run button on ${pageOf(a.slug)}, ` +
          `and appears as hub_skill_${out.saved.slug.replace(/[^a-z0-9_]/g, "_")} when your client reconnects.`,
      );
    },
  );

  server.registerTool(
    "hub_skill_update",
    {
      description:
        "Change one of an agent's skills. Only the fields you send change; parameters, when sent, replace the list. enabled: false hides it everywhere without deleting it.",
      inputSchema: {
        agent: z.string().min(1).describe("The agent's slug."),
        skill: z.string().min(1).describe("The skill's slug."),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        prompt: z.string().min(1).optional(),
        parameters: z.array(parameterSchema).optional(),
        enabled: z.boolean().optional(),
      },
    },
    async (args) => {
      const a = await getAgent(args.agent);
      if (!a) return text(`There is no agent "${args.agent}". hub_list_agents lists them.`);
      const current = (await listSkills(a.id)).find((s) => s.slug === args.skill);
      if (!current) return text(`${a.name} has no skill "${args.skill}". hub_agent_get lists its skills.`);
      const big = resolveLargeArgs(principal.id, args.prompt === undefined ? {} : { prompt: args.prompt });
      if ("error" in big) return text(big.error);
      const out = await saveSkillAs(principal, {
        id: current.id,
        agentId: a.id,
        slug: current.slug,
        name: args.name ?? current.name,
        description: args.description ?? current.description,
        promptTemplate: args.prompt === undefined ? current.promptTemplate : String(big.args.prompt),
        parameters: (args.parameters as SkillParameter[] | undefined) ?? current.parameters,
        enabled: args.enabled,
      });
      if ("error" in out) return text(`Not changed: ${out.error}`);
      return text(`Saved "${out.saved.name}"${out.saved.enabled ? "" : " (switched off)"}.`);
    },
  );
}

/** Tool servers asked for that the save left out, so the caller is told rather than finding out at run time. */
function droppedTools(asked: string[] | undefined, saved: { mcpServers?: unknown } | null): string[] {
  if (!asked || !saved) return [];
  const have = new Set(((saved.mcpServers ?? []) as McpEntry[]).map((e) => String(e.name)));
  return asked.filter((n) => n && n !== ASK_SERVER && !have.has(n));
}
