import type { Principal } from "./principal";

export type Action =
  | "document:read"
  | "document:write"
  | "rag:search"
  | "agent:run"
  | "session:read"
  | "admin:manage";

// The policy we OWN (see docs/07-tech-stack — AuthZ is core product #4). Role →
// allowed actions. `admin` is granted everything via a wildcard below.
const ROLE_GRANTS: Record<string, Action[]> = {
  analyst: [
    "document:read",
    "document:write",
    "rag:search",
    "agent:run",
    "session:read",
  ],
  // Read-only: can search the knowledge base and read what is in it, nothing more.
  viewer: ["document:read", "rag:search"],
};

// The PolicyEngine seam: a Zanzibar-style engine (OpenFGA/Cerbos, Phase 2)
// implements this same interface. We own the policy definitions today.
export interface PolicyEngine {
  check(principal: Principal, action: Action, resource?: string): Promise<boolean>;
}

class OwnedPolicyEngine implements PolicyEngine {
  async check(principal: Principal, action: Action, _resource?: string): Promise<boolean> {
    if (principal.roles.includes("admin")) return true;

    // Role-level only. The resource-level hook that used to live here checked
    // per-skill grant lists; skills are gone, and inventing a resource rule for
    // agents before anyone needs one would be guessing. `resource` stays in the
    // signature because the PolicyEngine seam (OpenFGA/Cerbos, Phase 2) is
    // resource-shaped and callers already pass it.
    return principal.roles.some((r) => (ROLE_GRANTS[r] ?? []).includes(action));
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

// Which roles may perform an action. `admin` is always included — it is granted
// everything.
export function rolesForAction(action: Action): string[] {
  const roles = Object.entries(ROLE_GRANTS)
    .filter(([, actions]) => actions.includes(action))
    .map(([role]) => role);
  return ["admin", ...roles];
}
