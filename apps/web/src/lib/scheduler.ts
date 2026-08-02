import { claimDueSchedules, recordScheduleResult } from "@ai-hub/db";
import { runSkill } from "./runSkill";

// Runs every schedule that is due now. Claiming advances next_run_at atomically
// (so overlapping ticks can't double-fire); we then execute each skill and record
// the outcome. Returns a small summary for logging/observability.
export async function runDueSchedules(): Promise<{
  ran: number;
  results: { id: string; slug: string; status: string }[];
}> {
  const due = await claimDueSchedules();
  const results: { id: string; slug: string; status: string }[] = [];

  for (const d of due) {
    let status = "succeeded";
    let runId: string | null = null;
    try {
      const out = await runSkill(d.slug, d.input, { retrieve: d.retrieve });
      if ("notFound" in out) status = "skill_unavailable";
      else runId = out.runId;
    } catch {
      status = "failed";
    }
    await recordScheduleResult(d.id, status, runId).catch(() => {});
    results.push({ id: d.id, slug: d.slug, status });
  }

  return { ran: due.length, results };
}
