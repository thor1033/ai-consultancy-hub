import type { Principal } from "@ai-hub/authz";
import { getAgent, handoffsFor, renderHandoffPrompt, type Handoff } from "@ai-hub/db";

/*
 * Hand-offs: when a run finishes, the hub starts the agents its hand-off rows
 * name, as the same person, pointed at the finished run (docs/agent-patterns.md).
 *
 * The first hand-off was written in code — the Secretary's meeting skills to
 * the Context Steward — and this generalises it to rows (packages/db/src/
 * handoffs.ts) so a pattern can wire a pipeline and a person can switch one
 * off. What did not change: an agent in a run has no way to hand anything to
 * anyone; the hub does it, after the run is recorded, through the same checks
 * any run goes through, and as the same person, so a scheduled run hands to
 * an agent that runs as the schedule's owner too. The hand-off widens nothing.
 *
 * A chain stops: a hand-off fires only from a run whose depth is below
 * HANDOFF_MAX_DEPTH, so two agents that hand to each other run twice and not
 * forever, and a pipeline is at most three stages from a person's run. Every
 * hand-off, made or refused, is said in the finished run's answer.
 */

/** A hand-off fires only from a run whose depth is below this. */
export const HANDOFF_MAX_DEPTH = 2;

export interface FinishedRun {
  sessionId: string;
  agentId: string;
  agentName: string;
  skillId: string | null;
  skillName: string | null;
  prompt: string;
  output: string;
  principal: Principal;
  depth: number;
}

export type StartOutcome = { kind: "running" | "done"; runId: string } | { kind: "error"; message: string };

/** Start an agent as this person, under this parent. The hub's run path, injected so this file has no cycle with it. */
export type StartAgent = (agentRef: string, prompt: string, principal: Principal, parent: { sessionId: string; depth: number }) => Promise<StartOutcome>;

/** The line a finished run's answer ends with for one hand-off. */
function line(h: Handoff, outcome: StartOutcome | { kind: "refused"; reason: string }): string {
  if (outcome.kind === "refused") return `\n\n**Not handed to ${h.toAgentName}:** ${outcome.reason}`;
  if (outcome.kind === "error") return `\n\n**Not handed to ${h.toAgentName}:** ${outcome.message}`;
  return `\n\n_Handed to ${h.toAgentName} (run ${outcome.runId})${h.note ? `: ${h.note}` : ""}._`;
}

/**
 * Fire the hand-offs of a finished run. Returns what to append to its answer:
 * one line per hand-off, made or not. Never throws — a hand-off that fails
 * must not fail the run it follows, but it must be said.
 */
export async function runHandoffs(run: FinishedRun, start: StartAgent): Promise<string> {
  let out = "";
  let rows: Handoff[];
  try {
    rows = await handoffsFor(run.agentId, run.skillId);
  } catch (err) {
    return `\n\n**Hand-offs not checked:** ${err instanceof Error ? err.message : String(err)}`;
  }
  for (const h of rows) {
    try {
      if (run.depth >= HANDOFF_MAX_DEPTH) {
        out += line(h, { kind: "refused", reason: `this run is already ${run.depth} hand-offs deep, and a chain stops at ${HANDOFF_MAX_DEPTH}.` });
        continue;
      }
      const target = await getAgent(h.toAgentId);
      if (!target) {
        out += line(h, { kind: "refused", reason: "it no longer exists." });
        continue;
      }
      if (!target.enabled) {
        out += line(h, { kind: "refused", reason: "it is switched off." });
        continue;
      }
      const prompt = renderHandoffPrompt(h.prompt, {
        sessionId: run.sessionId,
        output: run.output,
        prompt: run.prompt,
        agentName: run.agentName,
        skillName: run.skillName ?? "",
      });
      out += line(h, await start(target.slug, prompt, run.principal, { sessionId: run.sessionId, depth: run.depth + 1 }));
    } catch (err) {
      out += line(h, { kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
