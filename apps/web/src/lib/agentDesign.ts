import {
  getAgent,
  createAgent,
  updateAgent,
  isPlacement,
  type AgentInput,
  type McpEntry,
  ASK_SERVER,
  listSkills,
  createSkill,
  updateSkill,
  type Skill,
  type SkillParameter,
} from "@ai-hub/db";
import { authorize, type Action, type Principal } from "@ai-hub/authz";
import { MAX_ITERATIONS_CEILING } from "@ai-hub/agent";
import { isKnownServer } from "@/lib/runSession";
import { undeclaredPlaceholders } from "@/lib/skillPrompt";
import { MAILBOX_SERVERS, MODELS, serverWritesAllowed } from "@/app/agents/models";

/*
 * Designing agents and skills: the checks behind saving one, for every door.
 *
 * The agent form (app/agents/actions.ts) and the hub's MCP tools
 * (lib/mcp/designTools.ts) both save through here, as a principal: the browser
 * session's, or the bearer token's. One set of rules, so an agent built from
 * Claude Code is held to exactly what the form holds it to — which tool
 * servers it may name, who may let it write unattended, where it runs, which
 * agents it may ask, and what a skill's prompt may refer to.
 *
 * Revalidating pages is the caller's: a server action and a route handler do
 * it differently.
 */

// Postgres's unique_violation. Not imported from lib/apiError, which pulls in
// next/server: this module is also loaded by the MCP route and the verify scripts.
const isUniqueViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

export const NOT_ALLOWED = "You do not have permission to do that.";

export function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function saveAgentAs(
  principal: Principal | null,
  id: string | null,
  input: AgentInput,
): Promise<{ ok: true; id: string; slug: string } | { error: string }> {
  const can = async (action: Action) => Boolean(principal) && (await authorize(principal!, action));
  if (!(await can("agent:manage"))) return { error: NOT_ALLOWED };
  const name = input.name?.trim();
  if (!name) return { error: "An agent needs a name." };

  const slug = toSlug(input.slug?.trim() || name);
  if (!slug) return { error: "That name does not make a usable slug — use some letters." };
  // /agents/new is the builder, so an agent with that slug could never be opened.
  if (slug === "new") return { error: `"new" is reserved — give the agent a more specific name.` };

  // A server this agent already has is kept even if this deployment does not
  // declare it right now — otherwise saving any other field would silently cut
  // the agent off from it. New ones must be known; runSession skips undeclared
  // names at run time either way.
  const existing = id ? await getAgent(id) : null;
  const already = new Set(
    (existing?.mcpServers ?? []).map((e) => String((e as { name?: unknown }).name ?? "")),
  );
  // Letting an agent write without approval widens what it may do unattended,
  // so turning it on is admin-only; an entry that already has it keeps it.
  const alreadyAllowed = new Set(serverWritesAllowed(existing?.mcpServers ?? []));
  const admin = await can("admin:manage");
  // Rebuilt field by field rather than stored as sent. An entry is read back
  // at run time and a setting in it lands in a server's environment, so only
  // the settings a server is known to take get through, each checked.
  const servers: McpEntry[] = [];
  for (const e of input.mcpServers ?? []) {
    const name = (e as { name?: unknown }).name;
    if (typeof name !== "string" || !(isKnownServer(name) || already.has(name))) continue;
    const entry: McpEntry = { name };
    const mailbox = (e as { mailbox?: unknown }).mailbox;
    if (typeof mailbox === "string" && mailbox.trim()) {
      if (!MAILBOX_SERVERS.has(name)) return { error: `"${name}" does not take a mailbox.` };
      const clean = mailbox.trim().toLowerCase();
      if (clean.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
        return { error: `"${mailbox.trim()}" is not a mailbox address.` };
      }
      entry.mailbox = clean;
    }
    const writes = (e as { writes?: unknown }).writes;
    if (writes !== undefined && writes !== "ask" && writes !== "allow") {
      return { error: `"${name}": writes must be "ask" or "allow".` };
    }
    if (writes === "allow") {
      if (!alreadyAllowed.has(name) && !admin) {
        return { error: `Only an admin can let an agent write through "${name}" without approval.` };
      }
      entry.writes = "allow";
    }
    // Whom it may ask: slugs of agents that exist, never itself. Checked here
    // because the list is read at run time to build the ask tool; a slug that
    // is not an agent would be offered to the model and refuse every time.
    if (name === ASK_SERVER) {
      const raw = (e as { agents?: unknown }).agents;
      if (raw !== undefined && !Array.isArray(raw)) return { error: `"${name}": the agents it may ask must be a list of slugs.` };
      const asks: string[] = [];
      for (const s of (raw ?? []) as unknown[]) {
        if (typeof s !== "string" || !s.trim()) continue;
        const askSlug = s.trim();
        if (askSlug === slug || (existing && askSlug === existing.slug)) return { error: "An agent cannot ask itself." };
        if (!(await getAgent(askSlug))) return { error: `There is no agent "${askSlug}" to ask.` };
        if (!asks.includes(askSlug)) asks.push(askSlug);
      }
      entry.agents = asks;
    }
    servers.push(entry);
  }
  // The form only offers the models it lists; a tool call can send any string,
  // and an unknown id would fail every run of the agent. An id the agent
  // already has is kept, so an older or seeded model survives an edit.
  const model = input.model?.trim() || null;
  if (model && model !== existing?.model && !MODELS.some((m) => m.id === model)) {
    return { error: `Unknown model "${model}". Use one of: ${MODELS.filter((m) => m.id).map((m) => m.id).join(", ")}, or leave it empty for the default.` };
  }
  const keepsMemory = input.keepsMemory === undefined ? (existing?.keepsMemory ?? true) : input.keepsMemory === true;

  // A server action is a public endpoint, so the number is validated here and
  // not only by the <input type="number"> that usually produces it. Anything
  // unusable becomes null — the runtime default — rather than an error the
  // person cannot act on or a NaN that reaches Postgres.
  const raw = input.maxIterations;
  const maxIterations =
    raw === null || raw === undefined || !Number.isFinite(Number(raw))
      ? null
      : Math.min(Math.max(Math.trunc(Number(raw)), 1), MAX_ITERATIONS_CEILING);

  // Where an agent runs decides where its instructions are copied to and who
  // reaches its tools from outside the hub, so changing it is admin-only even
  // if agent:manage is one day granted more widely. `existing` is the lookup
  // the server list above already paid for.
  // Collection names are matched exactly against documents, so they are
  // checked for shape here; whether one exists is not an error (a drawer can
  // be named before anything is filed in it), and whether the asker may read
  // it is decided at retrieval time, never here.
  const knowledgeCollections: string[] = [];
  for (const raw of input.knowledgeCollections ?? []) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name) continue;
    if (name.length > 120) return { error: `"${name.slice(0, 40)}…" is too long for a collection name.` };
    if (!knowledgeCollections.includes(name)) knowledgeCollections.push(name);
  }
  if (knowledgeCollections.length > 50) return { error: "An agent can work from at most 50 collections." };
  const knowledgeAll = input.knowledgeAll === true;

  // Labels on the org chart. Free text, so only their shape is checked: a
  // function that is a paragraph breaks the chart's columns, and a stray
  // newline would make two "Delivery" columns that look the same.
  const label = (raw: unknown, what: string): string | { error: string } => {
    if (raw === undefined || raw === null) return "";
    if (typeof raw !== "string") return { error: `${what} must be text.` };
    const clean = raw.replace(/\s+/g, " ").trim();
    return clean.length > 60 ? { error: `${what} is too long (60 characters at most).` } : clean;
  };
  const functionName = label(input.functionName ?? existing?.functionName, "The function");
  if (typeof functionName !== "string") return functionName;
  const owner = label(input.owner ?? existing?.owner, "The owner");
  if (typeof owner !== "string") return owner;

  const placement = input.placement ?? existing?.placement ?? "hub";
  if (!isPlacement(placement)) return { error: "Unknown placement." };
  if (placement !== (existing?.placement ?? "hub") && !admin) {
    return { error: "Only an admin can change where an agent runs." };
  }

  // Only the fields a person sets. `pattern` and `source` record where an
  // agent came from and are written by the pattern and import paths alone.
  // An omitted field is left out rather than sent as undefined: updateAgent
  // merges over the stored row, and an undefined there would blank it.
  const clean = Object.fromEntries(
    Object.entries({
      description: input.description,
      instructions: input.instructions,
      model: input.model === undefined ? undefined : model,
      effort: input.effort,
      enabled: input.enabled,
    }).filter(([, v]) => v !== undefined),
  ) as Partial<AgentInput>;

  try {
    if (id) {
      const updated = await updateAgent(id, {
        ...clean,
        name,
        keepsMemory,
        // The pattern tag is where an agent came from; the form never sends it.
        pattern: existing?.pattern ?? null,
        mcpServers: servers,
        knowledgeCollections,
        knowledgeAll,
        maxIterations,
        placement,
        functionName,
        owner,
      });
      if (!updated) return { error: "That agent no longer exists." };
      return { ok: true, id: updated.id, slug: updated.slug };
    }
    const created = await createAgent({
      ...clean,
      name,
      slug,
      keepsMemory,
      pattern: null,
      mcpServers: servers,
      knowledgeCollections,
      knowledgeAll,
      maxIterations,
      placement,
      functionName,
      owner,
    });
    return { ok: true, id: created.id, slug: created.slug };
  } catch (e) {
    // A duplicate slug is the one failure a user can actually fix, so name it.
    const message = e instanceof Error ? e.message : "Could not save the agent.";
    if (/duplicate key|unique/i.test(message)) {
      return { error: `An agent with the slug "${slug}" already exists.` };
    }
    return { error: message };
  }
}


export interface SkillDraft {
  id?: string;
  agentId: string;
  slug: string;
  name: string;
  description: string;
  promptTemplate: string;
  parameters: SkillParameter[];
  /** Switch it on or off in the same save; omitted, it stays as it is. */
  enabled?: boolean;
}

export async function saveSkillAs(principal: Principal | null, input: SkillDraft): Promise<{ skills: Skill[]; saved: Skill } | { error: string }> {
  if (!principal || !(await authorize(principal, "agent:manage"))) return { error: NOT_ALLOWED };

  const slug = input.slug.trim().toLowerCase();
  // The slug becomes an MCP tool name, so it has to survive that translation
  // legibly rather than being mangled into something nobody recognises.
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    return { error: "Slug must be 2–63 characters: lowercase letters, digits and hyphens." };
  }
  if (!input.name.trim()) return { error: "Give the skill a name." };
  if (!input.promptTemplate.trim()) {
    return { error: "Write the prompt this skill runs." };
  }

  const parameters = input.parameters
    .map((p) => ({ ...p, name: p.name.trim() }))
    .filter((p) => p.name);
  const bad = parameters.find((p) => !/^[a-zA-Z0-9_]+$/.test(p.name));
  if (bad) {
    return { error: `Parameter "${bad.name}" must use letters, digits and underscores only.` };
  }

  // Caught here rather than at call time: a placeholder with no parameter can
  // never be filled, so the skill would ship a prompt with a literal
  // "{{client}}" in it and nobody would find out until a client read the output.
  const undeclared = undeclaredPlaceholders(input.promptTemplate, parameters);
  if (undeclared.length) {
    return {
      error: `The prompt uses {{${undeclared[0]}}}, but no parameter is called "${undeclared[0]}".`,
    };
  }

  // An update names the skill by id, and the list shown afterwards is the
  // agent's named in the call: they must agree before anything is written, or
  // the page would show one agent's skills after changing another's.
  if (input.id && !(await listSkills(input.agentId)).some((s) => s.id === input.id)) {
    return { error: "That skill belongs to another agent, or no longer exists." };
  }

  try {
    const saved = input.id
      ? await updateSkill(input.id, {
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          slug,
          name: input.name.trim(),
          description: input.description.trim(),
          promptTemplate: input.promptTemplate,
          parameters,
        })
      : await createSkill({
          agentId: input.agentId,
          slug,
          name: input.name.trim(),
          description: input.description.trim(),
          promptTemplate: input.promptTemplate,
          parameters,
        });
    if (!saved) return { error: "That skill no longer exists." };
    return { skills: await listSkills(input.agentId), saved };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { error: `Another skill already uses the slug "${slug}".` };
    }
    return { error: e instanceof Error ? e.message : "Could not save that skill." };
  }
}

