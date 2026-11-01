import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic } from "./client";
import { getLangfuse, traceValue } from "./tracing";
import {
  DEFAULT_MODEL,
  type ModelId,
  type TokenUsage,
  emptyUsage,
  addUsage,
  costUsd,
  totalTokens,
} from "./models";
import type { RunAgentInput, RunAgentResult, RunTimeline, TurnTiming } from "./types";

/**
 * "Today is Thursday 22 October 2026, 21:40 (Europe/Copenhagen)." in the
 * deployment's timezone — HUB_TIMEZONE, else the process's own, which on a
 * server is UTC. An unknown zone name falls back to UTC rather than throwing
 * inside every run.
 */
export function clockLine(now: Date, timeZone = process.env.HUB_TIMEZONE): string {
  const zone = timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  let stamp: string;
  let used = zone;
  try {
    stamp = fmt(zone);
  } catch {
    used = "UTC";
    stamp = fmt(used);
  }
  // en-GB gives "Thursday 22 October 2026 at 21:40" (older ICU: "Thursday, 22 October 2026, 21:40").
  const text = stamp.replace(/,?\s+at\s+/, ", ").replace(/^(\w+),\s/, "$1 ");
  return `Today is ${text} (${used}). Use this, not your training data, for anything relative to now: "this week", "tomorrow", "overdue".`;
}

const DEFAULT_SYSTEM =
  "You are the AI Hub agent. You run an organization's workflows and Skills " +
  "accurately and concisely, using the tools available to you. Prefer verified " +
  "facts from tools and provided context over guessing.";

/**
 * Default cap on the tool-use loop, when an agent does not set its own.
 *
 * Ten rounds is right for an agent that looks something up and answers. It is
 * not enough for one working through a queue — a secretary listing an inbox and
 * opening five messages fits, triaging forty does not — so an agent can raise
 * its own ceiling (`agents.max_iterations`).
 *
 * The cap is a cost and runaway-loop guard, not a correctness one: hitting it
 * means the run stopped mid-task, which `exhausted` reports rather than hides.
 */
export const DEFAULT_MAX_ITERATIONS = 10;

/**
 * The hard ceiling a per-agent value is clamped to. A misconfigured agent that
 * loops should cost a bounded amount of money, whatever its row says.
 */
export const MAX_ITERATIONS_CEILING = 100;

/**
 * Default output budget per model turn, covering the thinking AND the answer.
 *
 * It was 16000, and that was tight in both directions: the secretary's first
 * real change set was cut off mid-JSON at 16,040 tokens, and on `effort: high`
 * a run over a large tool result could spend the whole budget inside one
 * adaptive-thinking block and write nothing at all.
 *
 * It could not simply be raised: the SDK refuses a NON-streaming request whose
 * max_tokens implies more than ten minutes of generation (above ~21,333 it
 * throws "Streaming is required for operations that may take longer than 10
 * minutes" before the request leaves the process — total failure, on every
 * agent). So the model call below streams, and `finalMessage()` reassembles
 * the same Message the non-streaming call used to return. Nothing downstream
 * had to change; only the transport did. `npm run verify:loop` checks both
 * halves: that the request is a streamed one, and that this default is above
 * the old non-streaming ceiling.
 */
export const DEFAULT_MAX_TOKENS = 32000;

/**
 * Runs one agent turn (a full tool-use loop) against Claude and returns the
 * final text plus the ROI substrate (usage, cost, latency). Every model call
 * is traced to Langfuse when configured.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const model: ModelId = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const useThinking = input.thinking ?? true;
  const maxIterations = Math.min(
    Math.max(Math.trunc(input.maxIterations ?? DEFAULT_MAX_ITERATIONS), 1),
    MAX_ITERATIONS_CEILING,
  );

  const client = getAnthropic();
  const langfuse = getLangfuse();

  // Frozen system prompt with a cache breakpoint. Prompt caching only kicks in
  // above the model's minimum cacheable prefix (~4096 tokens on Opus 4.8), so
  // short prompts won't populate cache_creation — that's expected.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: input.system ?? DEFAULT_SYSTEM,
      cache_control: { type: "ephemeral" },
    },
  ];
  // The model has no clock. Without this, "this week" is whatever week its
  // training data last saw, and a calendar lookup is silently asked for the
  // wrong dates. Placed after the cache breakpoint: it changes every minute
  // and must not invalidate the cached persona above it.
  system.push({ type: "text", text: clockLine(new Date()) });
  // Retrieved context goes after the cached persona block (volatile, uncached).
  if (input.context) {
    system.push({
      type: "text",
      text: `Relevant context retrieved for this task:\n\n${input.context}`,
    });
  }

  const messages: Anthropic.MessageParam[] = [
    ...(input.history ?? []),
    { role: "user", content: input.prompt },
  ];

  // Client-side tools + executor supplied by the caller (e.g. the MCP layer).
  const tools: Anthropic.Tool[] = input.tools ?? [];
  const toolExecutor = input.toolExecutor;

  const trace = langfuse?.trace({
    name: "agent.run",
    input: traceValue({ prompt: input.prompt }),
    metadata: { model, ...input.metadata },
  });

  const started = Date.now();
  // Where the time goes, kept beside the loop rather than in it: a person asking
  // "why was this slow" needs to tell a long read of the prompt from long
  // thinking from a slow tool, and the totals below cannot.
  const approx = (chars: number) => Math.round(chars / 4);
  const timeline: RunTimeline = {
    version: 1,
    prompt: {
      brief: approx(system.slice(0, 2).reduce((n, b) => n + b.text.length, 0)),
      context: approx(input.context ? input.context.length : 0),
      tools: approx(tools.length ? JSON.stringify(tools).length : 0),
      history: approx(input.history?.length ? JSON.stringify(input.history).length : 0),
      prompt: approx(input.prompt.length),
    },
    turns: [],
    modelMs: 0,
    toolMs: 0,
  };
  let usage = emptyUsage();
  let iterations = 0;
  let stopReason: string | null = null;
  let finalText = "";
  const toolsUsed: string[] = []; // distinct, in first-use order

  while (iterations < maxIterations) {
    iterations++;
    const genStart = Date.now();
    const gen = trace?.generation({
      name: `claude.turn.${iterations}`,
      model,
      modelParameters: {
        max_tokens: maxTokens,
        thinking: useThinking ? "adaptive" : "disabled",
        effort: input.effort ?? null,
      },
      input: traceValue(messages),
    });

    // Streamed, then reassembled: `finalMessage()` folds the event stream back
    // into one Message — text deltas joined, tool_use inputs parsed from their
    // partial-JSON deltas, thinking blocks and their signatures kept, usage
    // summed from message_start and message_delta — so the rest of this loop
    // reads it exactly as it read the non-streaming response. The point is not
    // the streaming itself but what it unlocks: the SDK only permits an output
    // budget above the ten-minute line on a streamed request (see
    // DEFAULT_MAX_TOKENS).
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      thinking: useThinking ? { type: "adaptive" } : { type: "disabled" },
      ...(input.effort ? { output_config: { effort: input.effort } } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
    });
    // Timed from the stream's own events: when the first content arrived, and
    // how long each block took to stream, by kind.
    const turn: TurnTiming = {
      turn: iterations,
      startMs: genStart - started,
      firstTokenMs: null,
      thinkingMs: 0,
      writingMs: 0,
      toolInputMs: 0,
      totalMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason: null,
      tools: [],
    };
    const openBlocks = new Map<number, { kind: string; at: number }>();
    stream.on("streamEvent", (event) => {
      const now = Date.now();
      if (event.type === "content_block_start") {
        if (turn.firstTokenMs === null) turn.firstTokenMs = now - genStart;
        openBlocks.set(event.index, { kind: event.content_block.type, at: now });
      } else if (event.type === "content_block_stop") {
        const open = openBlocks.get(event.index);
        if (!open) return;
        const ms = now - open.at;
        if (open.kind === "thinking" || open.kind === "redacted_thinking") turn.thinkingMs += ms;
        else if (open.kind === "text") turn.writingMs += ms;
        else if (open.kind === "tool_use") turn.toolInputMs += ms;
        openBlocks.delete(event.index);
      }
    });
    const response = await stream.finalMessage();
    turn.totalMs = Date.now() - genStart;
    timeline.modelMs += turn.totalMs;

    const turnUsage: TokenUsage = {
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    usage = addUsage(usage, turnUsage);
    stopReason = response.stop_reason;
    Object.assign(turn, turnUsage, { stopReason });
    timeline.turns.push(turn);

    const turnText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (turnText) finalText = turnText;

    gen?.end({
      output: traceValue(turnText),
      usage: {
        input: turnUsage.inputTokens,
        output: turnUsage.outputTokens,
        total: totalTokens(turnUsage),
        unit: "TOKENS",
      },
      metadata: {
        stopReason,
        cacheReadTokens: turnUsage.cacheReadTokens,
        cacheCreationTokens: turnUsage.cacheCreationTokens,
        costUsd: costUsd(model, turnUsage),
        latencyMs: Date.now() - genStart,
      },
    });

    // Preserve the full assistant turn (thinking + tool_use blocks) so a
    // follow-up request can continue the conversation correctly.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      if (!toolsUsed.includes(t.name)) toolsUsed.push(t.name);
      const span = trace?.span({ name: `tool.${t.name}`, input: traceValue(t.input) });
      const toolStart = Date.now();
      let content: string;
      let isError = false;
      if (toolExecutor) {
        try {
          content = await toolExecutor(t.name, t.input);
        } catch (err) {
          content = err instanceof Error ? err.message : "Tool execution failed.";
          isError = true;
        }
      } else {
        content = "No tools are registered in this hub yet.";
        isError = true;
      }
      span?.end({ output: traceValue(content) });
      const toolMs = Date.now() - toolStart;
      timeline.toolMs += toolMs;
      turn.tools.push({ name: t.name, ms: toolMs, resultChars: content.length, error: isError });
      toolResults.push({
        type: "tool_result",
        tool_use_id: t.id,
        content,
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // The loop only leaves with stop_reason still `tool_use` one way: it ran out
  // of iterations. The model had asked for another tool call and we stopped
  // answering, so whatever is in finalText is a partial thought, or nothing at
  // all — and without this the caller gets that partial as if it were the
  // answer. Say so in the output itself, because the output is what a person
  // reads; `exhausted` is the same fact for code.
  const exhausted = stopReason === "tool_use";
  if (exhausted) {
    const note =
      `[Stopped after ${maxIterations} rounds of tool use without reaching an answer. ` +
      `The work is incomplete — ask for a narrower slice of it, or raise this agent's ` +
      `iteration limit.]`;
    finalText = finalText ? `${finalText}\n\n${note}` : note;
  }

  // The other way to reach here having said nothing: the response was cut off
  // at max_tokens. With adaptive thinking that is not a rare edge — a hard
  // question over a large tool result can spend the WHOLE budget thinking and
  // get truncated mid-thought, so the turn carries a thinking block and no text
  // at all. Until this existed such a run was stored as `succeeded` with an
  // empty output: the most expensive possible silence, indistinguishable from
  // an agent that simply had nothing to say.
  //
  // Same principle as `exhausted` above — say it in the output, because the
  // output is what a person reads.
  if (!finalText.trim()) {
    finalText =
      stopReason === "max_tokens"
        ? `[Produced no answer: the response hit the ${maxTokens}-token output limit ` +
          `while still reasoning, so nothing was written. Nothing was lost except the ` +
          `run — retry with a smaller input (a narrower tool result), a lower effort ` +
          `setting, or a higher output limit.]`
        : `[Produced no answer (stop reason: ${stopReason ?? "unknown"}). This is a ` +
          `failed run, not an empty one.]`;
  }

  const latencyMs = Date.now() - started;
  const cost = costUsd(model, usage);

  trace?.update({
    output: traceValue(finalText),
    metadata: { stopReason, iterations, maxIterations, exhausted, costUsd: cost, latencyMs, ...usage },
  });
  await langfuse?.flushAsync();

  return {
    text: finalText,
    model,
    stopReason,
    iterations,
    maxIterations,
    exhausted,
    usage: { ...usage, totalTokens: totalTokens(usage) },
    costUsd: cost,
    latencyMs,
    traceId: trace?.id,
    transcript: messages,
    toolsUsed,
    timeline,
  };
}
