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

export const ALL_ACTIONS: Action[] = [
  "document:read",
  "document:write",
  "rag:search",
  "agent:run",
  "session:read",
  "admin:manage",
];

/** Every action a set of roles permits. `admin` is the wildcard it is in check(). */
export function actionsForRoles(roles: string[]): Set<Action> {
  if (roles.includes("admin")) return new Set(ALL_ACTIONS);
  const actions = new Set<Action>();
  for (const role of roles) {
    for (const action of ROLE_GRANTS[role] ?? []) actions.add(action);
  }
  return actions;
}

/**
 * Narrow a principal's roles to what a credential asks for, never widening.
 *
 * Compared by *permitted actions*, not by string equality, because roles are a
 * lattice and not a flat set. `viewer` is a strict subset of `analyst` — both
 * read documents and search, the analyst can also write and run — so an analyst
 * scoping a credential down to viewer is exactly the narrowing they intended.
 * A plain string intersection would call that empty and hand back a credential
 * that can do nothing, which is how "issue CI a read-only token" quietly
 * produces a dead token.
 *
 * A role the principal could not fully exercise is dropped rather than clamped:
 * a viewer asking for `analyst` gets nothing from it, because granting the
 * overlap would let the credential's role list decide policy.
 */
export function narrowRoles(principalRoles: string[], credentialRoles: string[]): string[] {
  if (!credentialRoles.length) return principalRoles;
  const permitted = actionsForRoles(principalRoles);
  return credentialRoles.filter((role) => {
    const wanted = actionsForRoles([role]);
    for (const action of wanted) {
      if (!permitted.has(action)) return false;
    }
    return true;
  });
}

// Which roles may perform an action. `admin` is always included — it is granted
// everything.
export function rolesForAction(action: Action): string[] {
  const roles = Object.entries(ROLE_GRANTS)
    .filter(([, actions]) => actions.includes(action))
    .map(([role]) => role);
  return ["admin", ...roles];
}
