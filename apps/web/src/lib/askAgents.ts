import type { ConnectedMcp } from "@ai-hub/mcp";
import { ASK_SERVER } from "@ai-hub/db";

/*
 * One agent asking another while it runs (docs/agent-patterns.md).
 *
 * The tool is `agents_ask`: give it the slug of an agent you may ask and the
 * ask in four fields (objective, context, format, boundaries), and it runs
 * that agent AS THE SAME PERSON, waits, and returns the answer. Asks that do
 * not depend on each other are run at once when the model makes them in one
 * turn (runSession's parallelSafe). It is the hub's own tool, built here in-process rather than as an
 * MCP server, because starting an agent needs the whole runtime (the person,
 * their reach, the approval gate) that a child process does not have.
 *
 * What bounds it, each a decision written down in the doc:
 *
 *   who may ask whom .... the asking agent's own entry, {"name":"agents",
 *                         "agents":[slugs]}: an allow-list on the row, like
 *                         its tool servers. No entry, no tool.
 *   how deep ............ a run may ask only below ASK_MAX_DEPTH. At 1, a
 *                         person's run asks a worker, and the worker asks
 *                         nobody: no fan-out of fan-outs, no loops.
 *   how many ............ ASK_BUDGET asks per run, then the tool refuses.
 *   how long ............ ASK_TIMEOUT_MS; after that the asker is told the
 *                         run is still going and where its answer lands.
 *   what it widens ...... nothing. The asked agent runs with its own tools,
 *                         memory and knowledge, as the same person, and its
 *                         writes are held for approval like any run's. The
 *                         ask itself is not held: it starts a run, which is
 *                         not a change to anything outside the hub.
 */

export const ASK_TOOL = "agents_ask";
/** A run may ask only if its depth is below this. */
export const ASK_MAX_DEPTH = 1;
/** Asks one run may make. */
export const ASK_BUDGET = 12;
/** How long an ask waits for the answer. */
export const ASK_TIMEOUT_MS = 10 * 60_000;

export interface Askable {
  slug: string;
  name: string;
  description: string;
}

export type AskOutcome =
  | { kind: "done"; runId: string; output: string }
  | { kind: "running"; runId: string }
  | { kind: "error"; message: string };

/** Starts the asked agent as the same person and waits up to the timeout. */
export type AskStart = (slug: string, task: string) => Promise<AskOutcome>;

export interface Asks {
  allowed: Askable[];
  start: AskStart;
}

type ToolDef = ConnectedMcp["tools"][number];

/**
 * The fields of an ask (docs/effective-agents-review.md, C1). Anthropic's
 * multi-agent post found that a delegation which names its objective, the
 * context the worker lacks, the answer's shape and its limits is the
 * difference between a worker that helps and one that wanders. The schema
 * asks for them one by one, so the model cannot forget one the way it can in
 * a single free-text task. `task` is kept for the old shape: an agent whose
 * brief still says "task" is not broken by this.
 */
export interface AskFields {
  objective: string;
  context?: string;
  format?: string;
  boundaries?: string;
}

/** The prompt the asked agent reads, built from the fields: the objective first, the rest under headings. */
export function askPrompt(fields: AskFields): string {
  const parts = [fields.objective.trim()];
  if (fields.context?.trim()) parts.push(`## What you need to know\n${fields.context.trim()}`);
  if (fields.format?.trim()) parts.push(`## The answer\n${fields.format.trim()}`);
  if (fields.boundaries?.trim()) parts.push(`## Boundaries\n${fields.boundaries.trim()}`);
  return parts.join("\n\n");
}

/** The tool as the model sees it: the agents it may ask are in the description and the schema. */
export function askTool(allowed: Askable[]): ToolDef {
  return {
    name: ASK_TOOL,
    description:
      "Ask another agent to do a task and get its answer. It runs as the same person you run as, with its own tools, memory and knowledge; " +
      "any write it proposes waits for a person's approval, like yours. It sees ONLY what you send: it cannot see your conversation, " +
      "so copy in the facts it needs. Say the objective, the context, the answer's shape and the boundaries one by one. " +
      "Asks that do not depend on each other can be made in the same turn; they run at once. " +
      `You may ask:\n${allowed.map((a) => `- ${a.slug}: ${a.name}${a.description ? ` — ${a.description}` : ""}`).join("\n")}`,
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: allowed.map((a) => a.slug), description: "Which agent, by slug." },
        objective: { type: "string", description: "What you want it to do, in one or two sentences, and what it is for." },
        context: { type: "string", description: "What it needs to know that it cannot see: the facts, names, dates and material from your conversation." },
        format: { type: "string", description: "What a good answer looks like: shape, length, what must be in it." },
        boundaries: { type: "string", description: "What it must not do or assume, and where to stop. Optional." },
        task: { type: "string", description: "The old single field. Use objective, context and format instead." },
      },
      required: ["agent", "objective", "context", "format"],
    },
  };
}

/** The executor behind the tool, with the budget counted per run. */
export function askExecutor(asks: Asks, state: { used: number } = { used: 0 }): (input: unknown) => Promise<string> {
  const bySlug = new Map(asks.allowed.map((a) => [a.slug, a]));
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return async (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const slug = str(raw.agent);
    const target = bySlug.get(slug);
    if (!target) {
      return `You may not ask "${slug || "(no agent)"}". You may ask: ${asks.allowed.map((a) => a.slug).join(", ") || "nobody"}.`;
    }
    // The objective is the one field without which there is no ask; a bare
    // `task` stands in for it. The others are asked for, not demanded: a
    // worker told less does worse, not nothing.
    const objective = str(raw.objective) || str(raw.task);
    if (!objective) return `Say what you want ${target.name} to do: its objective, what it needs to know, and what the answer should look like.`;
    const text = askPrompt({ objective, context: str(raw.context), format: str(raw.format), boundaries: str(raw.boundaries) });
    if (state.used >= ASK_BUDGET) {
      return `You have asked other agents ${ASK_BUDGET} times in this run, which is the limit. Finish with what you have and say what you could not ask.`;
    }
    state.used++;
    const out = await asks.start(target.slug, text);
    if (out.kind === "error") return `${target.name} could not be asked: ${out.message}`;
    if (out.kind === "running") {
      return (
        `${target.name} is still working after ${Math.round(ASK_TIMEOUT_MS / 60_000)} minutes (run ${out.runId}). ` +
        `Do not wait for it: say in your answer that its result is on its run page, and finish without it.`
      );
    }
    return `${target.name} answered (run ${out.runId}):\n\n${out.output}`;
  };
}

/** Whether an agent's entries name the pseudo-server at all. */
export const isAskServer = (name: string) => name === ASK_SERVER;
