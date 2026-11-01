/*
 * Every agent that lives in code, in the order a release applies them.
 *
 * Adding one here is how a new seeded agent reaches production: its own
 * seed-*.mjs runs the checks on a laptop and at image build, and the release
 * command applies this list (packages/db/release.mjs). An agent not listed
 * here is the page's alone, and no deploy touches it.
 */
import type { Seed } from "./apply";
import { SECRETARY_AGENT, SECRETARY_MEMORIES, SECRETARY_SKILLS } from "./secretary";
import { PROJECT_MANAGER_AGENT, PROJECT_MANAGER_MEMORIES, PROJECT_MANAGER_SKILLS } from "./project-manager";
import { PRODUCTS, productOwnerAgent, productOwnerMemories, productOwnerSkills } from "./product-owner";
import { CONTEXT_STEWARD_AGENT, CONTEXT_STEWARD_HANDOFFS, CONTEXT_STEWARD_MEMORIES } from "./context-steward";

export const SEEDS: Seed[] = [
  { agent: SECRETARY_AGENT, skills: SECRETARY_SKILLS, memories: SECRETARY_MEMORIES },
  { agent: PROJECT_MANAGER_AGENT, skills: PROJECT_MANAGER_SKILLS, memories: PROJECT_MANAGER_MEMORIES },
  ...Object.values(PRODUCTS).map((p) => ({ agent: productOwnerAgent(p), skills: productOwnerSkills(p), memories: productOwnerMemories(p) })),
  // No skills: the steward's work is the sweep, asked for or scheduled, not a
  // packaged task. Its one memory is the empty ledger, and the release rules
  // keep whatever the steward has written into it since.
  // Its two hand-offs come from the Secretary's meeting skills, so it is
  // listed after the Secretary: a hand-off whose other side is not there yet
  // is skipped, and said.
  { agent: CONTEXT_STEWARD_AGENT, skills: [], memories: CONTEXT_STEWARD_MEMORIES, handoffs: CONTEXT_STEWARD_HANDOFFS },
];

/**
 * The seeds this deployment installs (docs/client-deployment.md).
 *
 *   HUB_SEEDS unset          every seed: the vendor's own hub, as before
 *   HUB_SEEDS=none           none
 *   HUB_SEEDS=a,b            those, by agent slug, in the order above
 *
 * The seeds are the vendor's own agents — a Secretary on the vendor's
 * mailbox, product owners for the vendor's products — so a client's hub names
 * the ones it wants (usually just context-steward, or none). A slug that is
 * not a seed is an error, which stops the release: a typo that silently
 * installed nothing would surface weeks later as a missing agent.
 */
export function selectSeeds(env: NodeJS.ProcessEnv = process.env, all: Seed[] = SEEDS): { seeds: Seed[] } | { error: string } {
  const raw = env.HUB_SEEDS?.trim();
  if (!raw) return { seeds: all };
  if (raw.toLowerCase() === "none") return { seeds: [] };
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set(all.map((s) => s.agent.slug));
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length) return { error: `HUB_SEEDS names ${unknown.map((u) => `"${u}"`).join(", ")}, which ${unknown.length === 1 ? "is not a seeded agent" : "are not seeded agents"}. Known: ${[...known].join(", ")}.` };
  return { seeds: all.filter((s) => wanted.includes(s.agent.slug)) };
}
