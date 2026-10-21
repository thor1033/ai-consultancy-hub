import type { Agent, Skill, SkillParameter } from "@ai-hub/db";

/*
 * An agent placed "local" or "both", rendered as the files Claude Code reads.
 *
 * The hub stays the source of truth: these files are generated on every sync,
 * overwritten, and deleted when an agent moves back to "hub". What they must
 * NOT carry is anything the hub enforces — a credential, another agent's
 * memory, a tool the agent may not reach. Those stay behind the per-agent
 * endpoint (/api/mcp/agents/<slug>), which re-checks them on every call. A
 * sub-agent file is instructions plus a URL; editing it buys nothing a token
 * would not already allow.
 *
 * Pure functions, so the agent page can show exactly what a sync will write.
 */

/** Paths are relative to the project's `.claude/` directory. */
export interface LocalFile {
  path: string;
  content: string;
}

/** Everything the sync hook writes is prefixed, so it never touches a hand-made file. */
export const LOCAL_PREFIX = "hub-";

/** Anything a slug can hold that a file or agent name should not, folded to a hyphen. */
const safeName = (slug: string) =>
  LOCAL_PREFIX + slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

export const localAgentName = (slug: string) => safeName(slug);
export const localSkillName = (slug: string) => safeName(slug);

/** The MCP server a synced sub-agent connects to: its own, and only its own. */
export const agentEndpoint = (baseUrl: string, slug: string) =>
  `${baseUrl.replace(/\/+$/, "")}/api/mcp/agents/${encodeURIComponent(slug)}`;

/** The name the sub-agent's inline server is known by, and so its tools' prefix. */
export const serverNameFor = (slug: string) => localAgentName(slug);

// Claude Code's sub-agent `model` takes an alias or a full model id. The hub
// stores full ids or nothing; nothing means "whatever the session uses".
const modelFor = (agent: Agent) => agent.model?.trim() || "inherit";

/** A YAML scalar that survives any description: JSON strings are valid YAML. */
const yamlString = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim());

export function renderSubAgent(agent: Agent, skills: Skill[], baseUrl: string): LocalFile {
  const name = localAgentName(agent.slug);
  const server = serverNameFor(agent.slug);
  const description =
    (agent.description.trim() || `The hub's "${agent.name}" agent.`) +
    ` Synced from the AI hub — edit it at ${baseUrl.replace(/\/+$/, "")}/agents/${agent.slug}; local edits are overwritten.`;

  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    `model: ${modelFor(agent)}`,
    ...(agent.effort ? [`effort: ${agent.effort}`] : []),
    ...(agent.maxIterations ? [`maxTurns: ${agent.maxIterations}`] : []),
    // Inline, so the server connects only while this sub-agent runs and the
    // parent session never sees its tools. The token comes from the
    // environment; the file itself holds no secret.
    "mcpServers:",
    `  - ${server}:`,
    "      type: http",
    `      url: ${agentEndpoint(baseUrl, agent.slug)}`,
    "      headers:",
    '        Authorization: "Bearer ${HUB_TOKEN:-}"',
    ...(skills.length
      ? ["skills:", ...skills.map((s) => `  - ${localSkillName(s.slug)}`)]
      : []),
    "---",
  ];

  const body = [
    agent.instructions.trim() || `You are ${agent.name}.`,
    "",
    "## Working through the hub",
    "",
    `You are the hub's "${agent.name}" agent, running inside a Claude Code session.`,
    `Your memory, your knowledge and your tools all come from the \`${server}\` MCP server,`,
    "which the hub checks on every call. Your tools there are named",
    `\`mcp__${server}__<tool>\`.`,
    "",
    "- Start by calling `hub_memory_list`: it returns your active memories, the work in flight.",
    "- Record durable facts with `hub_memory_write`; mark finished work inactive with",
    "  `hub_memory_set_active`. Do not store what you can look up again.",
    "- Use `hub_search_knowledge` for company context before answering from assumption.",
    "- If the hub refuses a call, say so. Do not work around it with other tools or files —",
    "  what the hub refuses is what this agent is not allowed to do.",
  ];

  return {
    path: `agents/${name}.md`,
    content: frontmatter.join("\n") + "\n\n" + body.join("\n") + "\n",
  };
}

function describeParameter(p: SkillParameter): string {
  const bits = [
    `\`${p.name}\``,
    p.required ? "(required)" : "(optional)",
    p.description ? `— ${p.description}` : "",
    p.options?.length ? `One of: ${p.options.map((o) => `\`${o}\``).join(", ")}.` : "",
  ];
  return `- ${bits.filter(Boolean).join(" ")}`;
}

export function renderSkill(skill: Skill, agent: Agent, baseUrl: string): LocalFile {
  const name = localSkillName(skill.slug);
  const params = skill.parameters ?? [];
  const description =
    (skill.description.trim() || `Run the "${skill.name}" workflow.`) +
    ` Carried out by the ${localAgentName(agent.slug)} sub-agent. Synced from the AI hub.`;

  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    ...(params.length
      ? [`argument-hint: ${yamlString(params.map((p) => `${p.name}=…`).join(" "))}`]
      : []),
    // Forked into the agent that owns the skill: its instructions, its memory
    // and its tools — the same agent the hub would have run it as.
    "context: fork",
    `agent: ${localAgentName(agent.slug)}`,
    "---",
  ];

  const body = [
    `# ${skill.name}`,
    "",
    ...(params.length
      ? [
          "## Arguments",
          "",
          "Given as: $ARGUMENTS",
          "",
          ...params.map(describeParameter),
          "",
          "Read each parameter from the arguments above. If a required one is missing,",
          "stop and say which — do not guess it.",
          "",
        ]
      : []),
    "## Task",
    "",
    // Kept verbatim, placeholders and all: the hub's {{name}} syntax is what the
    // parameters above refer to, and rewriting it would make the two drift.
    skill.promptTemplate.trim(),
    "",
    `<!-- Synced from the AI hub: ${baseUrl.replace(/\/+$/, "")}/agents/${agent.slug} -->`,
  ];

  return {
    path: `skills/${name}/SKILL.md`,
    content: frontmatter.join("\n") + "\n\n" + body.join("\n") + "\n",
  };
}

/** Every file one agent contributes: its sub-agent, and one skill per enabled skill. */
export function renderAgentFiles(agent: Agent, skills: Skill[], baseUrl: string): LocalFile[] {
  const enabled = skills.filter((s) => s.enabled);
  return [
    renderSubAgent(agent, enabled, baseUrl),
    ...enabled.map((s) => renderSkill(s, agent, baseUrl)),
  ];
}
