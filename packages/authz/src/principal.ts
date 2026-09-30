import {
  findPrincipalByIdentity,
  bindWorkosUser,
  verifyCredential,
  touchCredential,
  recordAuthEvent,
} from "@ai-hub/db";
import { isHubToken, tokenPrefix, hashToken, hashesEqual } from "./token";
import { narrowRoles } from "./policy";
import { verifyAccessToken, describeTokenFailure, looksLikeJwt } from "./oauth";

/**
 * Who is asking.
 *
 * Three ways to arrive, one shape to answer with. Callers have never needed to
 * know which door a request came through and still don't — `authenticate()` is
 * the same seam it always was, it just no longer resolves against a JSON blob
 * in an environment variable.
 *
 *   oauth       An AuthKit access token. The front door: every human surface
 *               (Claude Code, ChatGPT Enterprise, M365 Copilot) can get one,
 *               and the person behind it is a row we can disable.
 *   credential  A `hub_sk_…` token issued from /admin. The service door, for
 *               clients that cannot do OAuth. Revocable without a deploy.
 *   env         The legacy HUB_API_TOKENS map. Deprecated — see below.
 *   schedule    Nobody asked. A schedule fired, and the run executes as the
 *               principal who owns it (see agent_schedules). There is no token
 *               and no request behind this one, which is exactly why it is a
 *               distinct source in the audit trail rather than borrowed.
 *   teams       Someone spoke to the bot in a Microsoft Teams channel. The
 *               request is authenticated (a Bot Framework token), but not as
 *               this person — it proves Microsoft sent it, not who typed. The
 *               identity comes from the activity's sender, resolved to an
 *               email and matched against `principals`, so a Teams user the hub
 *               does not know gets no run at all. Distinct in the audit trail
 *               because the trust chain is genuinely different from OAuth's.
 */
export type PrincipalSource = "oauth" | "credential" | "env" | "schedule" | "teams";

export interface Principal {
  id: string;
  roles: string[];
  /**
   * The agent whose memory this principal opens, if any.
   *
   * Bound to the credential (or to the person), never accepted as a tool
   * argument, for the same reason the stdio memory server takes HUB_AGENT_ID
   * from its environment: a model that can name another agent's id could
   * otherwise read that agent's memory. With several clients on one hub that is
   * a cross-client leak.
   *
   * A principal without this simply has no memory tools — there is no id to
   * fall back to, and guessing one would be the leak.
   */
  agentId?: string;
  /** How this principal authenticated. */
  source: PrincipalSource;
  /** Present for OAuth principals, and for credentials whose owner has an email. */
  email?: string;
  /** The credential row used, when the source is `credential`. */
  credentialId?: string;
}

// --- legacy: HUB_API_TOKENS -------------------------------------------------

/**
 * The old model, kept alive on purpose and on a timer.
 *
 * A JSON map of hand-minted secrets in an environment variable: unreadable once
 * deployed, unrevocable without a deploy, and replaced wholesale by each deploy
 * — which on 6 September revoked three live tokens one after another and left a
 * placeholder from .env.example granting admin on a public endpoint for half an
 * hour. It is the thing increment 01 exists to remove.
 *
 * It still resolves because production is running on it right now and cutting it
 * mid-migration would lock the operator out of the console they need in order to
 * issue its replacement. Set HUB_DISABLE_LEGACY_TOKENS=1 once the last client
 * has moved, then delete the secret.
 */
interface LegacyEntry {
  id: string;
  roles: string[];
  agentId?: string;
  hash: string;
}

let legacyTokens: LegacyEntry[] | undefined;

function loadLegacyTokens(): LegacyEntry[] {
  if (legacyTokens) return legacyTokens;
  legacyTokens = [];
  if (process.env.HUB_DISABLE_LEGACY_TOKENS === "1") return legacyTokens;

  const raw = process.env.HUB_API_TOKENS;
  if (!raw) return legacyTokens;
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      { id: string; roles?: string[]; agentId?: unknown }
    >;
    for (const [token, p] of Object.entries(parsed)) {
      if (!p || typeof p.id !== "string") continue;
      // A non-string agentId is dropped rather than coerced: a malformed binding
      // must not silently become a binding to something else.
      const agentId =
        typeof p.agentId === "string" && p.agentId.trim() !== "" ? p.agentId.trim() : undefined;
      legacyTokens.push({
        id: p.id,
        roles: p.roles ?? [],
        ...(agentId ? { agentId } : {}),
        // Hashed at load so the comparison below can be constant-time. The
        // plaintext is already in the process environment; this is about the
        // comparison, not about hiding it.
        hash: hashToken(token),
      });
    }
  } catch {
    // Malformed config ⇒ no valid tokens (fail closed).
  }
  return legacyTokens;
}

function resolveLegacy(token: string): Principal | null {
  const presented = hashToken(token);
  for (const entry of loadLegacyTokens()) {
    if (hashesEqual(entry.hash, presented)) {
      return {
        id: entry.id,
        roles: entry.roles,
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        source: "env",
      };
    }
  }
  return null;
}

/** Whether the deprecated env map is still carrying anyone. Surfaced in /admin. */
export function legacyTokenCount(): number {
  return loadLegacyTokens().length;
}

// --- the resolvers ----------------------------------------------------------

async function resolveOAuth(token: string): Promise<Principal | null> {
  const identity = await verifyAccessToken(token);
  if (!identity) {
    await recordAuthEvent({
      event: "auth.denied",
      source: "oauth",
      detail: { reason: describeTokenFailure(token) },
    });
    return null;
  }

  // The token proves identity; this lookup is what turns identity into
  // permission. An email that nobody has granted anything gets nothing — and
  // says so in the audit trail, because "a real person signed in and bounced" is
  // exactly the event an operator needs to see in order to act on it.
  const row = await findPrincipalByIdentity({
    workosUserId: identity.workosUserId,
    email: identity.email,
  });

  if (!row || !row.enabled) {
    await recordAuthEvent({
      event: "auth.denied",
      source: "oauth",
      detail: {
        reason: row ? "principal_disabled" : "no_principal",
        email: identity.email,
        workosUserId: identity.workosUserId,
      },
    });
    return null;
  }

  // First token from a person whose row was created by email: bind the WorkOS
  // id so later lookups do not depend on the address staying put.
  if (!row.workosUserId) {
    await bindWorkosUser(row.id, identity.workosUserId).catch(() => {});
  }

  return {
    id: row.id,
    roles: row.roles,
    ...(row.agentId ? { agentId: row.agentId } : {}),
    source: "oauth",
    ...(identity.email ?? row.email ? { email: identity.email ?? row.email! } : {}),
  };
}

async function resolveCredential(token: string): Promise<Principal | null> {
  const verified = await verifyCredential(tokenPrefix(token), hashToken(token));
  if (!verified) {
    await recordAuthEvent({
      event: "auth.denied",
      source: "credential",
      // The prefix is not secret and is the only thing that makes a failure
      // actionable — it says *which* credential was presented, so a revoked one
      // still in a config file is identifiable without the secret.
      detail: { reason: "unknown_or_revoked", tokenPrefix: tokenPrefix(token) },
    });
    return null;
  }

  const { credential, principal } = verified;
  await touchCredential(credential.id).catch(() => {});

  // A credential may narrow its owner's roles but never widen them, so a
  // credential minted before a demotion cannot outlive it. Compared by
  // permitted actions rather than by name — see narrowRoles().
  const roles = narrowRoles(principal.roles, credential.roles);

  const agentId = credential.agentId ?? principal.agentId ?? undefined;

  return {
    id: principal.id,
    roles,
    ...(agentId ? { agentId } : {}),
    source: "credential",
    ...(principal.email ? { email: principal.email } : {}),
    credentialId: credential.id,
  };
}

/**
 * Authenticate a request.
 *
 * Routed by the shape of the token rather than tried against every verifier in
 * turn: a JWT is only ever an AuthKit token, a `hub_sk_…` string is only ever a
 * credential, and anything else can only be the legacy map. That keeps one
 * failed lookup from being logged as three, and keeps a malformed JWT from
 * reaching the database at all.
 *
 * Fails closed everywhere, including when the database is unreachable — an
 * unverifiable principal is no principal.
 */
export async function authenticate(headers: Headers): Promise<Principal | null> {
  const match = (headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  try {
    if (looksLikeJwt(token)) return await resolveOAuth(token);
    if (isHubToken(token)) return await resolveCredential(token);
    return resolveLegacy(token);
  } catch (err) {
    // A database outage must not become an open door. It also must not become a
    // silent one: this is the failure an operator will be staring at.
    console.error("authenticate() failed:", err);
    return null;
  }
}
