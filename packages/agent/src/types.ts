import type Anthropic from "@anthropic-ai/sdk";
import type { ModelId } from "./models";

export interface RunAgentInput {
  /** The user's request for this turn (MVP: a single text message). */
  prompt: string;
  /** Prior conversation turns, in order, that precede `prompt` (chat mode). */
  history?: Anthropic.MessageParam[];
  /** Optional system prompt override; defaults to the hub agent persona. */
  system?: string;
  model?: ModelId;
  /** Adaptive thinking on/off. Defaults to on. */
  thinking?: boolean;
  effort?: "low" | "medium" | "high" | "max";
  maxTokens?: number;
  /**
   * Cap on rounds of tool use. Defaults to DEFAULT_MAX_ITERATIONS, clamped to
   * MAX_ITERATIONS_CEILING. A run that hits it comes back `exhausted`.
   */
  maxIterations?: number;
  /** Retrieved context (e.g. from RAG) injected as an extra system block. */
  context?: string;
  /** Tools exposed to Claude this turn (e.g. from the MCP layer). */
  tools?: Anthropic.Tool[];
  /** Executes a tool call by name and returns its text result. */
  toolExecutor?: (name: string, input: unknown) => Promise<string>;
  /** Arbitrary metadata attached to the Langfuse trace (e.g. skillId, tenantId). */
  metadata?: Record<string, unknown>;
  /**
   * False: send nothing to Langfuse for this run — not even its shape. For a
   * run that touched special-category material (docs/sensitivity.md), whose
   * tool names and timings can say what it was about. Default: traced when
   * Langfuse is configured.
   */
  trace?: boolean;
}

export interface RunAgentResult {
  text: string;
  model: string;
  stopReason: string | null;
  iterations: number;
  /** The cap this run actually ran under, after clamping. */
  maxIterations: number;
  /**
   * True when the run stopped because it hit `maxIterations` with the model
   * still asking for tools — i.e. the task was not finished. `text` carries a
   * note saying so, because that is what a person sees.
   */
  exhausted: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
  };
  costUsd: number;
  latencyMs: number;
  /** Langfuse trace id, when tracing is configured. */
  traceId?: string;
  /**
   * The full message transcript (user + assistant turns, including tool_use and
   * tool_result blocks). This is the raw material the Skillification loop
   * distills into a reusable Skill (docs/04).
   */
  transcript: Anthropic.MessageParam[];
  /** Distinct tool names Claude actually invoked this session, in first-use order. */
  toolsUsed: string[];
  /** Where the time went, turn by turn. Numbers and tool names only, never content. */
  timeline: RunTimeline;
}

/**
 * Where a run's time went. It holds no prompt, answer or tool result — only
 * durations, token counts, sizes and tool names — so it can be shown to anyone
 * who may see that the run happened, and stored beside it without widening
 * who can read what was said.
 */
export interface RunTimeline {
  version: 1;
  /** Approximate size of what the first request carried, in tokens (characters / 4). */
  prompt: PromptShape;
  turns: TurnTiming[];
  /** Total time inside model calls, and inside tool calls, across the run. */
  modelMs: number;
  toolMs: number;
}

/**
 * The first request, by part. Approximate on purpose: it is computed on every
 * run, and an exact count would be an extra API call per run. The bench
 * (packages/agent/bench-prompt.mjs) counts exactly.
 */
export interface PromptShape {
  /** The agent's instructions (the cached system block) plus the clock line. */
  brief: number;
  /** Knowledge retrieved for this run, if any. */
  context: number;
  /** The tool definitions the model is shown. */
  tools: number;
  /** Earlier turns of a chat. */
  history: number;
  /** The request itself. */
  prompt: number;
}

export interface TurnTiming {
  turn: number;
  /** When this model call started, from the start of the run. */
  startMs: number;
  /**
   * From sending the request to the first streamed content. This is reading
   * the prompt, plus any thinking the model does without streaming it.
   */
  firstTokenMs: number | null;
  /** Time inside streamed thinking blocks. */
  thinkingMs: number;
  /** Time writing text. */
  writingMs: number;
  /** Time writing tool calls' arguments. */
  toolInputMs: number;
  /** The whole model call. */
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  stopReason: string | null;
  /** The tools this turn asked for, run after it, in order. */
  tools: ToolTiming[];
}

export interface ToolTiming {
  name: string;
  ms: number;
  /** Size of what the tool returned, which the next turn reads as input. */
  resultChars: number;
  error: boolean;
}
