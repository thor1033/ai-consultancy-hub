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
import { CONTEXT_STEWARD_AGENT, CONTEXT_STEWARD_MEMORIES } from "./context-steward";

export const SEEDS: Seed[] = [
  { agent: SECRETARY_AGENT, skills: SECRETARY_SKILLS, memories: SECRETARY_MEMORIES },
  { agent: PROJECT_MANAGER_AGENT, skills: PROJECT_MANAGER_SKILLS, memories: PROJECT_MANAGER_MEMORIES },
  ...Object.values(PRODUCTS).map((p) => ({ agent: productOwnerAgent(p), skills: productOwnerSkills(p), memories: productOwnerMemories(p) })),
  // No skills: the steward's work is the sweep, asked for or scheduled, not a
  // packaged task. Its one memory is the empty ledger, and the release rules
  // keep whatever the steward has written into it since.
  { agent: CONTEXT_STEWARD_AGENT, skills: [], memories: CONTEXT_STEWARD_MEMORIES },
];
