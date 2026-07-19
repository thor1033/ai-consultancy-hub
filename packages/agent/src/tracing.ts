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
