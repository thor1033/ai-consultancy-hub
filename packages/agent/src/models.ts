// Model catalog + pricing. Pricing is USD per 1M tokens (see docs/07-tech-stack).
// cacheWrite = 1.25x input (5-min TTL); cacheRead = 0.1x input.

export const MODELS = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
} as const;

export type ModelId =
  | "claude-opus-4-8"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5";

export const DEFAULT_MODEL: ModelId = "claude-opus-4-8";

interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING: Record<ModelId, Pricing> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export interface TokenUsage {
  inputTokens: number; // uncached input
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

// The ROI substrate: what this run actually cost in model spend.
export function costUsd(model: ModelId, u: TokenUsage): number {
  const p = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  return (
    u.inputTokens * p.input +
    u.outputTokens * p.output +
    u.cacheReadTokens * p.cacheRead +
    u.cacheCreationTokens * p.cacheWrite
  ) / 1_000_000;
}
