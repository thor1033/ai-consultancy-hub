"use server";

import { revalidatePath } from "next/cache";
import {
  createAgent,
  createSkill,
  getAgent,
  getSkill,
  listAgents,
  HUB_RULES_ADDENDUM,
  SKILL_REQUEST_PARAMETER,
  skillTemplateFrom,
  type ImportSource,
  type ParsedAgentFile,
} from "@ai-hub/db";
import { fetchAgentFile } from "@/lib/importAgentFile";
import { sessionCan } from "@/lib/sessionPrincipal";

const NOT_ALLOWED = "Only an admin can import agents and skills.";

export interface ImportPreview {
  source: ImportSource;
  parsed: ParsedAgentFile;
  /** Which shape the file looks like, from its frontmatter. */
  looksLike: "skill" | "agent" | "bare";
  /** A slug the hub would use, free to edit. */
  suggestedSlug: string;
  /** The hub model id the file's alias maps to, if any. */
  model: string | null;
  agents: { id: string; slug: string; name: string }[];
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const MODEL_ALIASES: Record<string, string> = { opus: "claude-opus-4-8", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5" };

export async function previewImportAction(url: string): Promise<ImportPreview | { error: string }> {
  if (!(await sessionCan("agent:run"))) return { error: NOT_ALLOWED };
  if (typeof url !== "string" || url.length > 2000) return { error: "That is not a URL." };
  const fetched = await fetchAgentFile(url);
  if ("error" in fetched) return fetched;
  const { parsed, source, target } = fetched;
  const looksLike = parsed.bare ? "bare" : /SKILL\.md$/i.test(source.path) ? "skill" : "agent";
  const fileName = target.path.split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "") ?? "";
  const suggestedSlug = slugify(parsed.name || (fileName.toLowerCase() === "skill" ? target.path.split("/").filter(Boolean).at(-2) ?? "" : fileName) || "imported");
  return {
    source,
    parsed,
    looksLike,
    suggestedSlug,
    model: parsed.model ? (MODEL_ALIASES[parsed.model] ?? null) : null,
    agents: (await listAgents()).map((a) => ({ id: a.id, slug: a.slug, name: a.name })),
  };
}

export interface ImportInput {
  url: string;
  as: "agent" | "skill";
  slug: string;
  name: string;
  description: string;
  /** For `as: "skill"`: the agent that gets it. */
  agentId?: string;
  /** For `as: "agent"`: where it sits. */
  functionName?: string;
  owner?: string;
  /** Append the hub's standing rules to the brief. */
  addHubRules: boolean;
}

export async function importAction(input: ImportInput): Promise<{ ok: true; href: string } | { error: string }> {
  if (!(await sessionCan("agent:manage"))) return { error: NOT_ALLOWED };
  // Fetched again at creation rather than trusted from the preview: the
  // preview is the client's copy of what it saw, and the row must hold what
  // GitHub serves now, with its hash.
  const fetched = await fetchAgentFile(input.url);
  if ("error" in fetched) return fetched;
  const { parsed, source } = fetched;
  const name = (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) return { error: "Give it a name." };
  const slug = slugify(input.slug || name);
  if (!slug || slug === "new" || slug === "import" || slug === "patterns") return { error: "That name does not make a usable slug." };
  const description = (input.description ?? parsed.description).replace(/\s+/g, " ").trim().slice(0, 500);
  const body = input.addHubRules ? `${parsed.body}${HUB_RULES_ADDENDUM}` : parsed.body;

  try {
    if (input.as === "skill") {
      const agent = input.agentId ? await getAgent(input.agentId) : null;
      if (!agent) return { error: "Pick the agent that gets this skill." };
      if (await getSkill(slug)) return { error: `A skill with the slug "${slug}" already exists.` };
      await createSkill({
        agentId: agent.id,
        slug,
        name,
        description,
        promptTemplate: skillTemplateFrom(body),
        parameters: [SKILL_REQUEST_PARAMETER],
        source,
      });
      revalidatePath(`/agents/${agent.slug}`);
      return { ok: true, href: `/agents/${agent.slug}#skills` };
    }
    if (await getAgent(slug)) return { error: `An agent with the slug "${slug}" already exists.` };
    const label = (raw: string | undefined) => (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const model = parsed.model ? (MODEL_ALIASES[parsed.model] ?? null) : null;
    const created = await createAgent({
      slug,
      name,
      description,
      instructions: body,
      model,
      // Nothing the file asked for is granted: tools and memory are chosen on
      // the agent's page, by a person, from what this hub has.
      mcpServers: [],
      functionName: label(input.functionName),
      owner: label(input.owner),
      source,
    });
    revalidatePath("/agents");
    return { ok: true, href: `/agents/${created.slug}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not import it." };
  }
}
