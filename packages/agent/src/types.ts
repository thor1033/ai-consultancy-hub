import type Anthropic from "@anthropic-ai/sdk";
import type { ModelId } from "./models";

export interface RunAgentInput {
  /** The user's request for this turn (MVP: a single text message). */
  prompt: string;
  /** Optional system prompt override; defaults to the hub agent persona. */
  system?: string;
  model?: ModelId;
  /** Adaptive thinking on/off. Defaults to on. */
  thinking?: boolean;
  effort?: "low" | "medium" | "high" | "max";
  maxTokens?: number;
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
