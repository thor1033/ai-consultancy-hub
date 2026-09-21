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
}
