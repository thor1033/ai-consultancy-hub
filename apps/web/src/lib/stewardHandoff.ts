import type { Principal } from "@ai-hub/authz";
import { getAgent, STEWARD_HANDOFF_SKILLS, STEWARD_SLUG, stewardHandoffPrompt } from "@ai-hub/db";

/*
 * The hand-off from the Secretary to the Context Steward.
 *
 * When the Secretary turns a meeting into a change set (meeting-to-pm) or
 * follows one up on the clock (meeting-followup), the meeting has also taught
 * the firm something: a decision, a definition, a correction. That is the
 * steward's to propose, not the Secretary's — one agent keeps the record, the
 * other says what to keep (docs/context-steward.md). An agent in a hub run has
 * no way to call another agent, so the hub does the handing: when such a run
 * finishes, it starts a steward run AS THE SAME PERSON, pointed at that run,
 * and the steward's proposals land in /approvals beside the Secretary's.
 *
 * As the same person on purpose: a scheduled follow-up runs as the schedule's
 * owner, so the steward then runs as them too, and the steward's chat tools
 * see the Secretary's session only if that person allows the steward to read
 * their chats (HUB_STEWARD_READERS). The hand-off widens nothing.
 */

export interface HandoffSkill {
  slug: string;
  name: string;
}

export interface HandoffInput {
  skill: HandoffSkill;
  /** The run being handed over: the steward reads it with knowledge_chat_get. */
  sessionId: string;
  /** The agent whose run it was. The steward itself is never handed its own runs. */
  agentSlug: string;
  agentName: string;
  principal: Principal;
}

/** What starting the steward returns: the shape runAgentForPrincipal gives, reduced to what is needed here. */
export type StartOutcome =
  | { kind: "running"; runId: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; message: string };

export type StartAgent = (agentRef: string, prompt: string, principal: Principal) => Promise<StartOutcome>;

/**
 * Which skills hand off. The seed names the Secretary's two meeting skills;
 * the deployment may say otherwise (HUB_STEWARD_HANDOFF_SKILLS, comma-
 * separated slugs; an empty value turns the hand-off off).
 */
export function handoffSkills(): string[] {
  const raw = process.env.HUB_STEWARD_HANDOFF_SKILLS;
  if (raw === undefined) return [...STEWARD_HANDOFF_SKILLS];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function wantsHandoff(skillSlug: string, agentSlug: string): boolean {
  return agentSlug !== STEWARD_SLUG && handoffSkills().includes(skillSlug);
}

/**
 * Hand a finished run to the steward. Returns the line the run's own answer
 * ends with, so the person reading it knows the steward is on it — or why it
 * is not. Never throws: a hand-off that fails must not fail the run it is
 * appended to, but it must be said.
 */
export async function handOffToSteward(input: HandoffInput, start: StartAgent): Promise<string> {
  try {
    const steward = await getAgent(STEWARD_SLUG);
    if (!steward) return `\n\n**Not handed to the Context Steward:** no agent "${STEWARD_SLUG}" exists on this hub.`;
    if (!steward.enabled) return `\n\n**Not handed to the Context Steward:** it is switched off.`;
    const prompt = stewardHandoffPrompt({
      sessionId: input.sessionId,
      skillName: input.skill.name,
      agentName: input.agentName,
    });
    const out = await start(STEWARD_SLUG, prompt, input.principal);
    if (out.kind === "error") return `\n\n**Not handed to the Context Steward:** ${out.message}`;
    return (
      `\n\n_Handed to the Context Steward (run ${out.runId.slice(0, 8)}): it reads this meeting and proposes what ` +
      `the firm should keep from it — decisions, definitions, corrections — on /approvals._`
    );
  } catch (err) {
    return `\n\n**Not handed to the Context Steward:** ${err instanceof Error ? err.message : String(err)}`;
  }
}
