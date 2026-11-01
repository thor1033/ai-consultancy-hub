import {
  runDueSchedules,
  getPrincipal,
  type Schedule,
  type TickOutcome,
  lastRetentionSweep,
  sweepRetentionAndRecord,
  type RetentionSweep,
} from "@ai-hub/db";
import type { Principal } from "@ai-hub/authz";
import { runAgentForPrincipal, runSkillForPrincipal } from "./agentRuns";

/*
 * The ticker.
 *
 * Everything else in the hub starts with a person: a chat turn, an API call, a
 * tool call from an MCP client. This is the one path that does not, which is
 * what makes an agent a worker rather than a window.
 *
 * The decisions live in @ai-hub/db (which schedules are due, who may claim
 * one); this file is the thin part that turns a claimed schedule into an agent
 * run. The dependency points that way on purpose — it is what lets the whole
 * selection → claim → record cycle be verified against a real database without
 * the MCP layer, RAG or the policy engine (packages/db/verify-schedules.mjs).
 */

const TICK_MS = 60_000;

/**
 * How long a tick waits on one run before moving to the next.
 *
 * Deliberately short. Nobody is waiting for the answer, the run continues in
 * the container after this resolves, and a scheduled briefing that takes four
 * minutes must not hold up the other schedules behind it.
 */
const SCHEDULED_RUN_DEADLINE_MS = 5_000;

/**
 * The owner, as a principal.
 *
 * A scheduled run executes as the person who scheduled it. Retrieval is scoped
 * to the caller's grants, and an unattended run has no caller — so rather than
 * inventing an identity with a reach of its own, it borrows the reach of the
 * person who asked for it. `schedulesToConsider` already excludes disabled
 * owners; this re-checks because the row can change between the query and the
 * run, and the failure should be a recorded refusal rather than a run.
 */
async function ownerPrincipal(schedule: Schedule): Promise<Principal | { error: string }> {
  const owner = await getPrincipal(schedule.ownerPrincipalId);
  if (!owner) return { error: `The principal that owns this schedule no longer exists.` };
  if (!owner.enabled) return { error: `${owner.displayName || owner.id} is disabled.` };
  return {
    id: owner.id,
    roles: owner.roles,
    source: "schedule",
    ...(owner.email ? { email: owner.email } : {}),
    ...(owner.agentId ? { agentId: owner.agentId } : {}),
  };
}

/** One pass of the clock. Exported so it can be driven by hand. */
export async function tick(now: Date = new Date()): Promise<TickOutcome> {
  return runDueSchedules(async (schedule) => {
    const principal = await ownerPrincipal(schedule);
    if ("error" in principal) return { error: principal.error };

    // A skill schedule fills the skill's template at fire time, so the 07:00
    // brief and one asked for by hand at 09:00 are the same prompt from the
    // same place, and editing the skill edits the schedule.
    const outcome = schedule.agentSkillId
      ? await runSkillForPrincipal({
          skillRef: schedule.agentSkillId,
          args: schedule.skillArgs ?? {},
          principal,
          deadlineMs: SCHEDULED_RUN_DEADLINE_MS,
        })
      : await runAgentForPrincipal({
          agentRef: schedule.agentId,
          prompt: schedule.prompt,
          principal,
          deadlineMs: SCHEDULED_RUN_DEADLINE_MS,
        });

    // `running` is the expected outcome, not a failure: the deadline above is
    // short, and the run owns finishing its own row either way.
    if (outcome.kind === "error") return { error: outcome.message };
    return { runId: outcome.runId };
  }, now);
}

/**
 * Retention (docs/retention.md): every six hours, the policy runs once —
 * paced by the last sweep on record, so several machines ticking at once
 * still sweep about once per window, and a restart does not sweep again.
 * A sweep is idempotent, so two that do overlap only repeat no-ops.
 */
export const RETENTION_EVERY_MS = 6 * 60 * 60_000;

export async function maybeSweepRetention(now: Date = new Date()): Promise<RetentionSweep | null> {
  const last = await lastRetentionSweep();
  if (last && now.getTime() - new Date(last.at).getTime() < RETENTION_EVERY_MS) return null;
  return sweepRetentionAndRecord("scheduler");
}

let sweeping = false;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Start ticking. Idempotent, and a no-op unless HUB_SCHEDULER=1.
 *
 * Off by default because the consequence of being wrong is an agent acting
 * unbidden: a dev container that picked up production's database, or a build
 * step, should not start reading someone's mailbox every minute. Production
 * opts in.
 *
 * Safe on more than one machine. Fly can run several, and every one of them
 * will tick — `claimSchedule` is what makes exactly one of them win.
 */
export function startScheduler(): boolean {
  if (process.env.HUB_SCHEDULER !== "1") return false;
  if (timer) return true;

  timer = setInterval(() => {
    // A tick that overruns must not stack on the next one. Schedules it skips
    // are still due a minute later; two overlapping passes would both see them.
    if (ticking) return;
    ticking = true;
    tick()
      .then((outcome) => {
        if (outcome.claimed > 0) {
          console.log(`[scheduler] ran ${outcome.claimed} of ${outcome.considered} schedule(s).`);
        }
        for (const r of outcome.ran) {
          if (r.error) console.warn(`[scheduler] schedule ${r.scheduleId} failed: ${r.error}`);
        }
      })
      .catch((err) => {
        // The database being briefly unreachable must not kill the ticker.
        console.warn(`[scheduler] tick failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        ticking = false;
      });
    // Retention on its own track: a slow sweep never delays a schedule, nor the reverse.
    if (!sweeping) {
      sweeping = true;
      maybeSweepRetention()
        .then((out) => {
          if (out) console.log(`[retention] swept: ${JSON.stringify(out)}`);
        })
        .catch((err) => console.warn(`[retention] sweep failed: ${err instanceof Error ? err.message : err}`))
        .finally(() => {
          sweeping = false;
        });
    }
  }, TICK_MS);

  // Do not hold the process open on its own account; the HTTP server does that.
  timer.unref?.();
  console.log(`[scheduler] started — ticking every ${TICK_MS / 1000}s.`);
  return true;
}
