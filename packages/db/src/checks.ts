// Checks on a skill (docs/effective-agents-review.md, D1): the kinds a person
// can write, how the plain ones are judged, and how a verdict reads. The judge
// kind needs the model and lives in apps/web (lib/checks.ts); everything here
// is pure, so the page and the tools can use it too.
//
// From Anthropic's evals post: grade the outcome and what was produced; prefer
// code-based graders (cheap, objective) and use a model where only a model
// can judge; give a judge an "unknown" answer so it does not guess.

export type CheckKind = "mentions" | "avoids" | "maxWords" | "writes" | "judge";

export interface SkillCheck {
  kind: CheckKind;
  /** What to look for, the limit, the count, or the standard — by kind. */
  value: string;
  /** For `writes`: only proposals of this tool count. Absent ⇒ any write. */
  tool?: string;
}

export interface CheckResult {
  kind: CheckKind;
  value: string;
  tool?: string;
  /** Passed, failed, or could not be judged. */
  ok: boolean | null;
  /** One line a person reads: what was found, or what the judge said. */
  detail: string;
}

export const CHECK_KINDS: readonly CheckKind[] = ["mentions", "avoids", "maxWords", "writes", "judge"];

/** How each kind reads to a person, for the editor and the verdict. */
export const CHECK_WORDS: Record<CheckKind, { label: string; help: string }> = {
  mentions: { label: "Must mention", help: "A word or phrase the answer has to contain, e.g. a price, a clause, a name. Case does not matter." },
  avoids: { label: "Must not mention", help: "A word or phrase the answer must not contain, e.g. a competitor, a phrase the client dislikes." },
  maxWords: { label: "At most this many words", help: "A number. Long answers are the most common complaint." },
  writes: { label: "Proposes this many changes", help: "A number: how many writes the run should hold for approval. 0 for a run that must change nothing. Name a tool to count only that one." },
  judge: { label: "Meets this standard", help: "Numbered points a reader could check from the answer alone. A second model reads the answer against them and says which fail — or that it cannot judge." },
};

/** Why a check is not usable, or null. */
export function checkProblem(c: SkillCheck): string | null {
  if (!CHECK_KINDS.includes(c.kind)) return `"${String(c.kind)}" is not a kind of check.`;
  const v = (c.value ?? "").trim();
  if (c.kind === "maxWords" || c.kind === "writes") {
    if (!/^\d{1,5}$/.test(v)) return `${CHECK_WORDS[c.kind].label} needs a whole number.`;
    return null;
  }
  if (!v) return `${CHECK_WORDS[c.kind].label} needs something to check.`;
  if (c.kind === "judge" && v.length > 4000) return "The standard is too long (4,000 characters at most).";
  return null;
}

/** A clean copy: trimmed, numbers normalised, tools kept only on `writes`. */
export function cleanChecks(checks: unknown): SkillCheck[] {
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((c): c is SkillCheck => Boolean(c) && typeof c === "object" && typeof (c as SkillCheck).kind === "string")
    .map((c) => ({
      kind: c.kind,
      value: String(c.value ?? "").trim(),
      ...(c.kind === "writes" && typeof c.tool === "string" && c.tool.trim() ? { tool: c.tool.trim() } : {}),
    }));
}

export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/**
 * Judge one plain check. `judge` is not decided here: it returns `ok: null`
 * with a detail saying so, and apps/web replaces it with the model's verdict.
 */
export function evaluateCheck(check: SkillCheck, outcome: { answer: string; proposals: { tool: string }[] }): CheckResult {
  const base = { kind: check.kind, value: check.value, ...(check.tool ? { tool: check.tool } : {}) };
  const answer = outcome.answer ?? "";
  switch (check.kind) {
    case "mentions": {
      const ok = answer.toLowerCase().includes(check.value.toLowerCase());
      return { ...base, ok, detail: ok ? `Mentions "${check.value}".` : `Does not mention "${check.value}".` };
    }
    case "avoids": {
      const ok = !answer.toLowerCase().includes(check.value.toLowerCase());
      return { ...base, ok, detail: ok ? `Does not mention "${check.value}".` : `Mentions "${check.value}".` };
    }
    case "maxWords": {
      const n = wordCount(answer);
      const limit = Number(check.value);
      return { ...base, ok: n <= limit, detail: `${n.toLocaleString("en-GB")} words${n <= limit ? "" : `, over ${limit.toLocaleString("en-GB")}`}.` };
    }
    case "writes": {
      const n = outcome.proposals.filter((p) => !check.tool || p.tool === check.tool).length;
      const want = Number(check.value);
      const what = check.tool ? `${check.tool} ` : "";
      return { ...base, ok: n === want, detail: n === want ? `${n} ${what}change${n === 1 ? "" : "s"} proposed, as expected.` : `${n} ${what}change${n === 1 ? "" : "s"} proposed; expected ${want}.` };
    }
    case "judge":
      return { ...base, ok: null, detail: "Not judged." };
  }
}

/** The verdict in one line: "Checked: 4 of 5 · missing a price". */
export function summarizeChecks(results: CheckResult[] | null | undefined): string | null {
  if (!results?.length) return null;
  const passed = results.filter((r) => r.ok === true).length;
  const unknown = results.filter((r) => r.ok === null).length;
  const failed = results.filter((r) => r.ok === false);
  const parts = [`Checked: ${passed} of ${results.length}`];
  if (unknown) parts.push(`${unknown} could not be judged`);
  for (const f of failed.slice(0, 2)) parts.push(f.detail.replace(/\.$/, ""));
  if (failed.length > 2) parts.push(`and ${failed.length - 2} more`);
  return parts.join(" · ");
}
