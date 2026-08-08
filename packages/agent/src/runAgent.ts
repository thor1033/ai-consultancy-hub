import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic } from "./client";
import { getLangfuse } from "./tracing";
import {
  DEFAULT_MODEL,
  type ModelId,
  type TokenUsage,
  emptyUsage,
  addUsage,
  costUsd,
  totalTokens,
} from "./models";
import type { RunAgentInput, RunAgentResult } from "./types";

const DEFAULT_SYSTEM =
  "You are the AI Hub agent. You run an organization's workflows and Skills " +
  "accurately and concisely, using the tools available to you. Prefer verified " +
  "facts from tools and provided context over guessing.";

// Safety cap on the tool-use loop. Only matters once tools exist (Thing 3);
// with no tools registered, the loop runs exactly one turn.
const MAX_ITERATIONS = 10;

/**
 * Runs one agent turn (a full tool-use loop) against Claude and returns the
 * final text plus the ROI substrate (usage, cost, latency). Every model call
 * is traced to Langfuse when configured.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const model: ModelId = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? 16000;
  const useThinking = input.thinking ?? true;

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
    input: { prompt: input.prompt },
    metadata: { model, ...input.metadata },
  });

  const started = Date.now();
  let usage = emptyUsage();
  let iterations = 0;
  let stopReason: string | null = null;
  let finalText = "";
  const toolsUsed: string[] = []; // distinct, in first-use order

  while (iterations < MAX_ITERATIONS) {
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
      input: messages,
    });

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      thinking: useThinking ? { type: "adaptive" } : { type: "disabled" },
      ...(input.effort ? { output_config: { effort: input.effort } } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
    });

    const turnUsage: TokenUsage = {
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    usage = addUsage(usage, turnUsage);
    stopReason = response.stop_reason;

    const turnText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (turnText) finalText = turnText;

    gen?.end({
      output: turnText,
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
      const span = trace?.span({ name: `tool.${t.name}`, input: t.input });
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
      span?.end({ output: content });
      toolResults.push({
        type: "tool_result",
        tool_use_id: t.id,
        content,
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  const latencyMs = Date.now() - started;
  const cost = costUsd(model, usage);

  trace?.update({
    output: finalText,
    metadata: { stopReason, iterations, costUsd: cost, latencyMs, ...usage },
  });
  await langfuse?.flushAsync();

  return {
    text: finalText,
    model,
    stopReason,
    iterations,
    usage: { ...usage, totalTokens: totalTokens(usage) },
    costUsd: cost,
    latencyMs,
    traceId: trace?.id,
    transcript: messages,
    toolsUsed,
  };
}
