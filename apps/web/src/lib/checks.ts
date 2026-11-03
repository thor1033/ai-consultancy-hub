import { runAgent } from "@ai-hub/agent";
import { CHEAPER_MODEL, evaluateCheck, listProposals, type CheckResult, type SkillCheck } from "@ai-hub/db";

/*
 * Checks on a skill, judged on a finished run (docs/effective-agents-review.md,
 * D1). The plain kinds are decided in code (@ai-hub/db checks.ts); `judge`
 * puts the answer and the standard in front of a second model call with no
 * tools, no memory and no trace, and reads its first line.
 *
 * Why a second call and not the agent itself: the agent that wrote the answer
 * grades it kindly. Why no tools: the judge reads what was produced, nothing
 * more, so its verdict is about the answer alone. Why the first line: a
 * verdict a person can read without the hub interpreting prose, and a model
 * that cannot decide says so instead of guessing, as Anthropic's evals post
 * asks of a grader.
 */

export const JUDGE_APPROVED = "APPROVED";
export const JUDGE_NOT_YET = "NOT YET";
export const JUDGE_CANNOT = "CANNOT JUDGE";

/** The judge's brief. It is told the shape of its answer and that unsure means unsure. */
export function judgeSystem(): string {
  return [
    "You check an answer written by another agent against a standard a person wrote. You see only the answer and the standard.",
    `Your first line is exactly one of: ${JUDGE_APPROVED}, ${JUDGE_NOT_YET}, ${JUDGE_CANNOT}.`,
    `${JUDGE_APPROVED} when every point of the standard is met by the answer alone. ${JUDGE_NOT_YET} when any point is not; then say which points fail and why, one line each, in plain words.`,
    `${JUDGE_CANNOT} when a point cannot be decided from the answer and the standard (it needs a source you do not have, or the standard is not about the answer); then say which point and why.`,
    "Be strict about what the standard says and nothing else. Do not add standards of your own. Do not rewrite the answer.",
  ].join("\n");
}

export function judgePrompt(standard: string, answer: string): string {
  return `## The standard\n${standard.trim()}\n\n## The answer\n${answer.trim() || "(empty)"}`;
}

/** The verdict from the judge's text: the first line decides, the rest is the detail. */
export function readVerdict(text: string): { ok: boolean | null; detail: string } {
  const lines = text.trim().split("\n").map((l) => l.trim());
  const first = (lines[0] ?? "").replace(/^[#*\s]+|[.:*\s]+$/g, "").toUpperCase();
  const rest = lines.slice(1).filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 600);
  if (first.startsWith(JUDGE_APPROVED)) return { ok: true, detail: "Meets the standard." };
  if (first.startsWith(JUDGE_NOT_YET)) return { ok: false, detail: rest || "Does not meet the standard." };
  if (first.startsWith(JUDGE_CANNOT)) return { ok: null, detail: `Could not judge: ${rest || "no reason given"}` };
  return { ok: null, detail: `Could not judge: the judge did not give a verdict (${text.trim().slice(0, 120) || "empty"})` };
}

export interface RunChecksInput {
  checks: SkillCheck[];
  answer: string;
  /** The run's id: its held writes are counted for the `writes` kind. */
  runId: string;
  /** Replaces the model call. The verify script uses it; the hub never does. */
  judge?: (standard: string, answer: string) => Promise<string>;
}

/** Judge every check of a skill against a finished run. Never throws for one check: it says so in that check's detail. */
export async function runChecks(input: RunChecksInput): Promise<CheckResult[]> {
  if (!input.checks.length) return [];
  const needsWrites = input.checks.some((c) => c.kind === "writes");
  // Held, approved, rejected: every write the run proposed, whatever a person did with it since.
  const proposals = needsWrites ? (await listProposals({ runId: input.runId }).catch(() => [])).map((p) => ({ tool: p.tool })) : [];
  const out: CheckResult[] = [];
  for (const check of input.checks) {
    const plain = evaluateCheck(check, { answer: input.answer, proposals });
    if (check.kind !== "judge") {
      out.push(plain);
      continue;
    }
    try {
      const text = input.judge ? await input.judge(check.value, input.answer) : await askJudge(check.value, input.answer);
      out.push({ ...plain, ...readVerdict(text) });
    } catch (err) {
      out.push({ ...plain, ok: null, detail: `Could not judge: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

/** One model call, no tools, no trace, on the cheaper model: a grader, not an agent. */
async function askJudge(standard: string, answer: string): Promise<string> {
  const r = await runAgent({
    prompt: judgePrompt(standard, answer),
    system: judgeSystem(),
    model: CHEAPER_MODEL,
    effort: "low",
    maxIterations: 1,
    trace: false,
    metadata: { source: "judge" },
  });
  return r.text;
}
