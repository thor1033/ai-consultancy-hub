// How a sensitivity label reads to a person (docs/sensitivity.md). No imports,
// so client components can use it; the rules themselves are in lib/sensitivity.ts.

type Sensitivity = "internal" | "confidential" | "special";

/** How a label reads to a person. */
export const SENSITIVITY_WORDS: Record<Sensitivity, { label: string; means: string }> = {
  internal: { label: "Internal", means: "The default. Treated like the rest of the hub." },
  confidential: {
    label: "Confidential",
    means: "Stays in the hub: never sent to Claude Code or Claude.ai, never remembered wider than this, and every read is logged.",
  },
  special: {
    label: "Special category",
    means: "Health, union membership and the like (GDPR art. 9). As confidential, and never remembered, no conversation record kept, not traced.",
  },
};
