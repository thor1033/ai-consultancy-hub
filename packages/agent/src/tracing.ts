import { Langfuse } from "langfuse";

let lf: Langfuse | null | undefined;

// Langfuse is the ROI/"money-saved" data source — every model call is traced
// with tokens, cost, and latency. Tracing is optional: with no keys configured
// the runtime still works, it just skips the trace (best-effort in dev).
export function getLangfuse(): Langfuse | null {
  if (lf !== undefined) return lf;

  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    lf = null;
    return lf;
  }

  lf = new Langfuse({
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: LANGFUSE_HOST,
  });
  return lf;
}

/**
 * Whether traces may carry content: prompts, messages, tool inputs and outputs,
 * answers. Off unless HUB_TRACE_CONTENT=1 (docs/data-protection-review.md, 2.6).
 *
 * Tracing exists for the ROI numbers — tokens, cost, latency, which tools ran
 * — and none of those needs a word of what was said. With content on, every
 * run's emails, documents and answers were copied to Langfuse's cloud under
 * the hub's account: a full second copy of a client's data, in a third party,
 * kept on that party's terms. A deployment that wants content in its traces
 * (its own self-hosted Langfuse, say) turns it on knowingly.
 */
export function traceContent(): boolean {
  return process.env.HUB_TRACE_CONTENT === "1";
}

/** What a trace records for a value: the value itself, or only how big it was. */
export function traceValue(value: unknown): unknown {
  if (traceContent()) return value;
  if (value === undefined || value === null) return value;
  const chars = typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
  return { omitted: "content is not traced (HUB_TRACE_CONTENT)", chars };
}
