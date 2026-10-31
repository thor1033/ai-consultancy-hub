import type { RunTimeline, TurnTiming } from "@ai-hub/agent";

/*
 * Reading a run's timeline (@ai-hub/agent RunTimeline) as a person would ask
 * about it: where did the time go, and what would make it faster. Pure, so
 * verify-run-timing.mjs checks the reading without a page or a database.
 *
 * The parts of a model call, as the stream shows them:
 *
 *   send ── first token ── thinking ── writing / tool arguments ── done
 *   └ reading ┘
 *
 * "Reading" is everything before the first streamed block: the model taking in
 * the prompt, plus any thinking it does without streaming it. A long reading
 * on a late turn usually means the prompt has grown — every tool result is
 * read again by every turn after it.
 */

export type PartKey = "reading" | "thinking" | "writing" | "toolArgs" | "tools" | "other";

export interface Part {
  key: PartKey;
  label: string;
  ms: number;
  /** Share of the run's total, 0–1. */
  share: number;
  color: string;
}

export const PART_STYLE: Record<PartKey, { label: string; color: string }> = {
  reading: { label: "Reading the prompt", color: "var(--muted)" },
  thinking: { label: "Thinking", color: "var(--ai)" },
  writing: { label: "Writing the answer", color: "var(--c-src)" },
  toolArgs: { label: "Writing tool calls", color: "var(--c-person)" },
  tools: { label: "Waiting on tools", color: "var(--c-skill)" },
  other: { label: "Other", color: "var(--faint)" },
};

export interface TimelineReading {
  totalMs: number;
  parts: Part[];
  /** The one sentence a person reads first: the biggest part, and what to do about it. */
  verdict: string;
  /** Further facts, each a sentence, most telling first. */
  notes: string[];
  /** The slowest tool call, if any. */
  slowestTool: { name: string; ms: number; turn: number } | null;
  /** The largest tool result, which every later turn reads again. */
  largestResult: { name: string; tokens: number; turn: number; rereadBy: number } | null;
}

/** "350 ms", "4.2 s", "2 min 05 s". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** "12,400" — tokens, as people read them. */
export function count(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

export function isTimeline(value: unknown): value is RunTimeline {
  const v = value as RunTimeline | null;
  return Boolean(v && v.version === 1 && Array.isArray(v.turns) && v.prompt);
}

function sum(turns: TurnTiming[], pick: (t: TurnTiming) => number): number {
  return turns.reduce((n, t) => n + pick(t), 0);
}

export function readTimeline(timeline: RunTimeline, latencyMs?: number | null): TimelineReading {
  const turns = timeline.turns;
  const reading = sum(turns, (t) => t.firstTokenMs ?? 0);
  const thinking = sum(turns, (t) => t.thinkingMs);
  const writing = sum(turns, (t) => t.writingMs);
  const toolArgs = sum(turns, (t) => t.toolInputMs);
  const tools = timeline.toolMs;
  const accounted = reading + thinking + writing + toolArgs + tools;
  const totalMs = Math.max(latencyMs ?? 0, timeline.modelMs + timeline.toolMs, accounted, 1);
  const other = Math.max(0, totalMs - accounted);

  const parts: Part[] = (
    [
      ["reading", reading],
      ["thinking", thinking],
      ["writing", writing],
      ["toolArgs", toolArgs],
      ["tools", tools],
      ["other", other],
    ] as [PartKey, number][]
  )
    .filter(([, ms]) => ms > 0)
    .map(([key, ms]) => ({ key, ms, share: ms / totalMs, ...PART_STYLE[key] }));

  let slowestTool: TimelineReading["slowestTool"] = null;
  let largestResult: TimelineReading["largestResult"] = null;
  for (const t of turns) {
    for (const call of t.tools) {
      if (!slowestTool || call.ms > slowestTool.ms) slowestTool = { name: call.name, ms: call.ms, turn: t.turn };
      const tokens = Math.round(call.resultChars / 4);
      if (!largestResult || tokens > largestResult.tokens) {
        largestResult = { name: call.name, tokens, turn: t.turn, rereadBy: turns.length - t.turn };
      }
    }
  }

  const ranked = [...parts].filter((p) => p.key !== "other").sort((a, b) => b.ms - a.ms);
  const biggest = ranked[0];
  // A near tie is two causes, not one: naming only the larger would send a
  // person after half the problem.
  const runnerUp = ranked[1] && ranked[1].ms >= biggest.ms * 0.75 ? ranked[1] : null;
  const last = turns.at(-1);
  const lastInput = last ? last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens : 0;
  const outputTokens = sum(turns, (t) => t.outputTokens);
  const pct = (p: Part) => `${Math.round(p.share * 100)}%`;

  let verdict: string;
  if (!biggest) {
    verdict = "This run recorded no time in any part.";
  } else if (biggest.key === "reading") {
    verdict =
      `Most of the time (${pct(biggest)}) went before the first token: the model reading the prompt, ` +
      `which had grown to about ${count(lastInput)} tokens by the last turn, and any thinking it did without showing it. ` +
      `Smaller tool results and a shorter brief make this faster; so does a lower effort.`;
  } else if (biggest.key === "thinking") {
    verdict =
      `Most of the time (${pct(biggest)}) was thinking. Lower the agent's effort, or make its brief or ` +
      `skill say more plainly what to do, so there is less to work out.`;
  } else if (biggest.key === "writing") {
    verdict =
      `Most of the time (${pct(biggest)}) was writing the answer: ${count(outputTokens)} tokens out across the run. ` +
      `Asking for a shorter answer or a tighter format is what makes this faster.`;
  } else if (biggest.key === "toolArgs") {
    verdict =
      `Most of the time (${pct(biggest)}) was writing tool calls' arguments — long inputs the model had to ` +
      `spell out. Tools that take an id rather than the content are faster.`;
  } else {
    verdict =
      `Most of the time (${pct(biggest)}) was waiting on tools` +
      (slowestTool ? `; the slowest was ${slowestTool.name} at ${duration(slowestTool.ms)} in turn ${slowestTool.turn}.` : ".") +
      ` That is the tool's server, not the prompt.`;
  }

  if (runnerUp) {
    verdict += ` ${runnerUp.label} took nearly as long (${pct(runnerUp)}).`;
  }

  const notes: string[] = [];
  if (turns.length > 1) {
    notes.push(
      `${turns.length} model calls, one after another: each one reads everything before it again, ` +
        `so fewer rounds of tool use is the largest saving available.`,
    );
  }
  if (largestResult && largestResult.tokens >= 2000 && largestResult.rereadBy > 0) {
    notes.push(
      `The largest tool result was ${largestResult.name} in turn ${largestResult.turn}, about ` +
        `${count(largestResult.tokens)} tokens, read again by ${largestResult.rereadBy} later ` +
        `turn${largestResult.rereadBy === 1 ? "" : "s"}. A narrower call (a filter, one item, a page) shrinks every turn after it.`,
    );
  }
  const first = turns[0];
  if (first && last && turns.length > 1) {
    const firstInput = first.inputTokens + first.cacheReadTokens + first.cacheCreationTokens;
    if (lastInput > firstInput * 1.5) {
      notes.push(`The prompt grew from about ${count(firstInput)} to ${count(lastInput)} tokens between the first turn and the last.`);
    }
  }
  const shape = timeline.prompt;
  const shapeParts: [string, number][] = [
    ["the agent's brief", shape.brief],
    ["retrieved knowledge", shape.context],
    ["the tool definitions", shape.tools],
    ["earlier chat turns", shape.history],
    ["the request itself", shape.prompt],
  ];
  const shapeTotal = shapeParts.reduce((n, [, v]) => n + v, 0);
  const [bigLabel, bigSize] = [...shapeParts].sort((a, b) => b[1] - a[1])[0];
  if (shapeTotal > 0 && bigSize / shapeTotal >= 0.5) {
    notes.push(
      `Of the first request, ${bigLabel} was the largest part: about ${count(bigSize)} of ${count(shapeTotal)} tokens.`,
    );
  }
  const cacheRead = sum(turns, (t) => t.cacheReadTokens);
  const allInput = sum(turns, (t) => t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens);
  if (allInput > 0 && turns.length > 1) {
    notes.push(
      cacheRead / allInput >= 0.3
        ? `${Math.round((cacheRead / allInput) * 100)}% of what was read came from the prompt cache, which is read faster and cheaper.`
        : `Little of what was read came from the prompt cache (${Math.round((cacheRead / allInput) * 100)}%).`,
    );
  }

  return { totalMs, parts, verdict, notes, slowestTool, largestResult };
}
