import { listSkillGrantPrincipals } from "@ai-hub/db";
import type { Principal } from "./principal";

export type Action =
  | "skill:read"
  | "skill:create"
  | "skill:write"
  | "skill:run"
  | "skill:grant"
  | "document:read"
  | "document:write"
  | "rag:search"
  | "agent:run"
  | "roi:read"
  | "session:read";

// The policy we OWN (see docs/07-tech-stack — AuthZ is core product #4). Role →
// allowed actions. `admin` is granted everything via a wildcard below.
const ROLE_GRANTS: Record<string, Action[]> = {
  analyst: [
    "skill:read",
    "skill:create",
    "skill:write",
    "skill:run",
    "document:read",
    "document:write",
    "rag:search",
    "agent:run",
    "roi:read",
    "session:read",
  ],
  // Directors/viewers get the ROI readout — it's the number they came for.
  viewer: ["skill:read", "document:read", "rag:search", "roi:read"],
};

// The PolicyEngine seam: a Zanzibar-style engine (OpenFGA/Cerbos, Phase 2)
// implements this same interface. We own the policy definitions today.
export interface PolicyEngine {
  check(principal: Principal, action: Action, resource?: string): Promise<boolean>;
}

class OwnedPolicyEngine implements PolicyEngine {
  async check(principal: Principal, action: Action, resource?: string): Promise<boolean> {
    if (principal.roles.includes("admin")) return true;

    const allowedByRole = principal.roles.some((r) =>
      (ROLE_GRANTS[r] ?? []).includes(action),
    );
    if (!allowedByRole) return false;

    // Resource-level: who can run which skill. If a skill has explicit grants,
    // the principal must be listed (admins already short-circuited above).
    if (action === "skill:run" && resource?.startsWith("skill:")) {
      const slug = resource.slice("skill:".length);
      const granted = await listSkillGrantPrincipals(slug);
      if (granted.length > 0 && !granted.includes(principal.id)) return false;
    }

    return true;
  }
}

const engine: PolicyEngine = new OwnedPolicyEngine();

export function authorize(
  principal: Principal,
  action: Action,
  resource?: string,
): Promise<boolean> {
  return engine.check(principal, action, resource);
}
