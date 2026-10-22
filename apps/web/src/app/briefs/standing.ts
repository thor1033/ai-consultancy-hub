import type { SkillWithAgent } from "@ai-hub/db";

/**
 * The arguments a brief runs with when nobody is there to type them.
 *
 * A brief is schedulable only when its template can be filled without a
 * person: every required parameter must be one this page knows how to answer.
 * Today that is `day`, answered with "today". Anything else and the page says
 * the brief has to be asked for by hand.
 *
 * A plain module rather than part of actions.ts, because everything exported
 * from a "use server" file becomes a server action, and this is a pure
 * function the page also calls while rendering.
 */
export function standingArgs(skill: Pick<SkillWithAgent, "parameters">): Record<string, string> | null {
  const args: Record<string, string> = {};
  for (const p of skill.parameters ?? []) {
    if (p.name === "day") args.day = "today";
    else if (p.required) return null;
  }
  return args;
}
