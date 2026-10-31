import type { ConnectedMcp } from "@ai-hub/mcp";
import { ASK_SERVER } from "@ai-hub/db";

/*
 * One agent asking another while it runs (docs/agent-patterns.md).
 *
 * The tool is `agents_ask`: give it the slug of an agent you may ask and a
 * task, and it runs that agent AS THE SAME PERSON, waits, and returns the
 * answer. It is the hub's own tool, built here in-process rather than as an
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

/** The tool as the model sees it: the agents it may ask are in the description and the schema. */
export function askTool(allowed: Askable[]): ToolDef {
  return {
    name: ASK_TOOL,
    description:
      "Ask another agent to do a task and get its answer. It runs as the same person you run as, with its own tools, memory and knowledge; " +
      "any write it proposes waits for a person's approval, like yours. It sees ONLY the task you send: copy in the facts and context it needs. " +
      `You may ask:\n${allowed.map((a) => `- ${a.slug}: ${a.name}${a.description ? ` — ${a.description}` : ""}`).join("\n")}`,
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: allowed.map((a) => a.slug), description: "Which agent, by slug." },
        task: { type: "string", description: "What you want it to do, with everything it needs to do it. It cannot see your conversation." },
      },
      required: ["agent", "task"],
    },
  };
}

/** The executor behind the tool, with the budget counted per run. */
export function askExecutor(asks: Asks, state: { used: number } = { used: 0 }): (input: unknown) => Promise<string> {
  const bySlug = new Map(asks.allowed.map((a) => [a.slug, a]));
  return async (input) => {
    const { agent, task } = (input ?? {}) as { agent?: unknown; task?: unknown };
    const slug = typeof agent === "string" ? agent.trim() : "";
    const target = bySlug.get(slug);
    if (!target) {
      return `You may not ask "${slug || "(no agent)"}". You may ask: ${asks.allowed.map((a) => a.slug).join(", ") || "nobody"}.`;
    }
    const text = typeof task === "string" ? task.trim() : "";
    if (!text) return `Say what you want ${target.name} to do.`;
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
