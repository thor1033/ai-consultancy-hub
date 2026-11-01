"use server";

import {
  listPrincipals,
  upsertPrincipal,
  setPrincipalEnabled,
  listCredentials,
  listAuthEvents,
  recordAuthEvent,
  listCollectionRows,
  listGrants,
  upsertCollection,
  grantCollection,
  revokeCollectionGrant,
  getSql,
  setCollectionSensitivity,
  isSensitivity,
  type Sensitivity,
} from "@ai-hub/db";
import {
  issueApiCredential,
  revokeApiCredential,
  legacyTokenCount,
  oauthConfig,
  mcpResource,
  defaultVisibility,
} from "@ai-hub/authz";
import { standingAdmin } from "@/lib/sessionPrincipal";
import { isVendorEmail } from "@ai-hub/authz";
import type { AccessSnapshot, AccessPrincipal } from "./types";

/*
 * Access management: who exists, what they hold, and what happened.
 *
 * Gated on the WorkOS session rather than on a bearer token, unlike the MCP
 * control plane next to it. That is deliberate and it is the whole bootstrap:
 * the console that issues credentials cannot itself require one, or the first
 * credential could never be issued and deleting HUB_API_TOKENS would lock
 * everyone out permanently. The browser door — AuthKit plus the email allowlist
 * — is the root of trust, and it is one a person can always get back through.
 */

type Result<T> = T | { error: string };

const DENIED = "Only an admin can manage access.";

/**
 * The signed-in admin's email (or id), or null.
 *
 * It used to be enough to be on the allowlist: that was written when the
 * allowlist was the two founders and nobody else. Now it is everyone who may
 * use the hub, viewers included, and every action below — making someone an
 * admin, issuing a credential, opening a restricted collection — would have
 * been theirs to call (docs/data-protection-review.md). So it is the
 * admin:manage role, read from the person's row, the same check every other
 * admin action makes. A new deployment's first admin is made by
 * sessionPrincipal's bootstrap, so this cannot lock the hub out of itself.
 *
 * Repeated in every action, not only on the page: a server action is its own
 * HTTP entry point and is callable without ever loading the page.
 */
// Admins with standing access only: temporary access cannot change who has
// access or what may leave the hub (lib/sessionPrincipal.ts, standingAdmin).
async function operator(): Promise<string | null> {
  const principal = await standingAdmin();
  return principal ? (principal.email ?? principal.id) : null;
}

async function snapshot(): Promise<AccessSnapshot> {
  const [principalRows, credentialRows, eventRows, collectionRows, grantRows, unfiled] =
    await Promise.all([
      listPrincipals(),
      listCredentials(),
      listAuthEvents(50),
      listCollectionRows(),
      listGrants(),
      countUnfiledDocuments(),
    ]);

  const grantsByCollection = new Map<string, string[]>();
  for (const g of grantRows) {
    grantsByCollection.set(g.collection, [
      ...(grantsByCollection.get(g.collection) ?? []),
      g.principalId,
    ]);
  }

  const liveCredentials = new Map<string, number>();
  for (const c of credentialRows) {
    liveCredentials.set(c.principalId, (liveCredentials.get(c.principalId) ?? 0) + 1);
  }

  const principals: AccessPrincipal[] = principalRows.map((p) => ({
    id: p.id,
    email: p.email,
    displayName: p.displayName,
    roles: p.roles,
    agentId: p.agentId,
    enabled: p.enabled,
    workosBound: Boolean(p.workosUserId),
    credentialCount: liveCredentials.get(p.id) ?? 0,
  }));

  const config = oauthConfig();
  const resource = mcpResource();

  return {
    principals,
    credentials: credentialRows.map((c) => ({
      id: c.id,
      name: c.name,
      principalId: c.principalId,
      tokenPrefix: c.tokenPrefix,
      roles: c.roles,
      agentId: c.agentId,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      lastUsedAt: c.lastUsedAt,
    })),
    events: eventRows.map((e) => ({
      id: e.id,
      at: e.at,
      event: e.event,
      source: e.source,
      principalId: e.principalId,
      actor: e.actor,
      detail: e.detail ?? {},
    })),
    oauth: {
      configured: Boolean(config),
      issuer: config?.issuer ?? null,
      resource: resource,
      metadataUrl: resource
        ? `${new URL(resource).origin}/.well-known/oauth-protected-resource`
        : null,
    },
    legacyTokens: legacyTokenCount(),
    knowledge: {
      collections: collectionRows.map((c) => ({
        name: c.name,
        visibility: c.visibility,
        sensitivity: c.sensitivity,
        documentCount: c.documentCount,
        grantedTo: grantsByCollection.get(c.name) ?? [],
        unclassified: !c.classified,
      })),
      defaultVisibility: defaultVisibility(),
      unfiledDocuments: unfiled,
    },
  };
}

async function countUnfiledDocuments(): Promise<number> {
  try {
    const sql = getSql();
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from documents
       where collection is null or collection = ''
    `;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function fail(e: unknown, fallback: string): { error: string } {
  return { error: e instanceof Error ? e.message : fallback };
}

export async function loadAccessAction(): Promise<Result<AccessSnapshot>> {
  if (!(await operator())) return { error: DENIED };
  try {
    return await snapshot();
  } catch (e) {
    return fail(e, "Failed to load access.");
  }
}

export interface SavePrincipalInput {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  agentId: string;
}

export async function savePrincipalAction(
  input: SavePrincipalInput,
): Promise<Result<AccessSnapshot>> {
  const actor = await operator();
  if (!actor) return { error: DENIED };

  const id = input.id.trim().toLowerCase();
  // The id is the stable handle everything else references — credentials point
  // at it and the audit trail records it — so it has to survive being typed by
  // a human into a form and read back out of a log.
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    return {
      error: "Id must be 2–63 characters: lowercase letters, digits and hyphens.",
    };
  }

  const email = input.email.trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "That does not look like an email address." };
  }

  const roles = input.roles.map((r) => r.trim()).filter(Boolean);

  // The vendor gets access through a grant with an end, never a standing row
  // (docs/client-deployment.md): that is the whole of "no standing access".
  if (isVendorEmail(email)) {
    return { error: `${email} is the vendor's. Give it temporary access instead — it ends by itself.` };
  }

  try {
    const saved = await upsertPrincipal({
      id,
      email: email || null,
      displayName: input.displayName.trim(),
      roles,
      agentId: input.agentId.trim() || null,
    });
    await recordAuthEvent({
      event: "principal.saved",
      principalId: saved.id,
      actor,
      detail: { email: saved.email, roles: saved.roles, agentId: saved.agentId },
    });
    return await snapshot();
  } catch (e) {
    return fail(e, "Could not save that principal.");
  }
}

export async function setPrincipalEnabledAction(
  id: string,
  enabled: boolean,
): Promise<Result<AccessSnapshot>> {
  const actor = await operator();
  if (!actor) return { error: DENIED };
  try {
    const ok = await setPrincipalEnabled(id, enabled);
    if (!ok) return { error: "Principal not found." };
    // Disabling is the break-glass control: it takes every credential that
    // principal holds out of service at once, which is what you reach for when
    // a laptop goes missing and you do not yet know which token was on it.
    await recordAuthEvent({
      event: enabled ? "principal.enabled" : "principal.disabled",
      principalId: id,
      actor,
    });
    return await snapshot();
  } catch (e) {
    return fail(e, "Update failed.");
  }
}

export interface IssueResult {
  /** Shown once and never again — the database keeps only a hash. */
  token: string;
  snapshot: AccessSnapshot;
}

export async function issueCredentialAction(input: {
  name: string;
  principalId: string;
  roles: string[];
  agentId: string;
  expiresInDays: number | null;
}): Promise<Result<IssueResult>> {
  const actor = await operator();
  if (!actor) return { error: DENIED };

  const name = input.name.trim();
  if (!name) return { error: "Give the credential a name — it is how you will recognise it later." };
  if (!input.principalId.trim()) return { error: "Choose who the credential belongs to." };

  const days = input.expiresInDays;
  if (days !== null && (!Number.isFinite(days) || days < 1 || days > 3650)) {
    return { error: "Expiry must be between 1 and 3650 days, or left empty." };
  }

  try {
    const { token } = await issueApiCredential({
      name,
      principalId: input.principalId.trim(),
      roles: input.roles.map((r) => r.trim()).filter(Boolean),
      agentId: input.agentId.trim() || null,
      expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000),
      actor,
    });
    return { token, snapshot: await snapshot() };
  } catch (e) {
    return fail(e, "Could not issue that credential.");
  }
}

export async function revokeCredentialAction(id: string): Promise<Result<AccessSnapshot>> {
  const actor = await operator();
  if (!actor) return { error: DENIED };
  try {
    const revoked = await revokeApiCredential(id, actor);
    if (!revoked) return { error: "That credential was already revoked." };
    return await snapshot();
  } catch (e) {
    return fail(e, "Revoke failed.");
  }
}

// --- knowledge access -------------------------------------------------------

export async function setCollectionVisibilityAction(
  name: string,
  visibility: "open" | "restricted",
): Promise<Result<AccessSnapshot>> {
  const actor = await operator();
  if (!actor) return { error: DENIED };
  try {
    // A labelled collection stays restricted (docs/sensitivity.md): opening it
    // to everyone would contradict the label rather than change who reads it.
    if (visibility === "open") {
      const row = (await listCollectionRows()).find((c) => c.name === name);
      if (row && row.sensitivity !== "internal") {
        return { error: `"${name}" is labelled ${row.sensitivity}. Set its label to internal before opening it to everyone.` };
      }
    }
    await upsertCollection({ name, visibility });
    await recordAuthEvent({
      event: "collection.visibility",
      actor,
      detail: { collection: name, visibility },
    });
    return await snapshot();
  } catch (e) {
    return fail(e, "Could not change that collection.");
  }
}

/**
 * Label a collection (docs/sensitivity.md). Admin-only, on the audit trail.
 * Takes effect on the next run, search or connection: nothing already
 * remembered or sent out is changed by a label set afterwards.
 */
export async function setCollectionSensitivityAction(name: string, sensitivity: Sensitivity): Promise<Result<AccessSnapshot>> {
  const actor = await operator();
  if (!actor) return { error: DENIED };
  if (!isSensitivity(sensitivity)) return { error: "That is not a label." };
  try {
    const out = await setCollectionSensitivity(name, sensitivity, defaultVisibility());
    if ("error" in out) return out;
    await recordAuthEvent({ event: "collection.sensitivity", actor, detail: { collection: name, sensitivity } });
    return await snapshot();
  } catch (e) {
    return fail(e, "Could not label that collection.");
  }
}

export async function grantCollectionAction(
  collection: string,
  principalId: string,
): Promise<Result<AccessSnapshot>> {
  const actor = await operator();
  if (!actor) return { error: DENIED };
  if (!collection.trim() || !principalId.trim()) {
    return { error: "Choose both a collection and a person." };
  }
  try {
    await grantCollection(collection.trim(), principalId.trim(), actor);
    await recordAuthEvent({
      event: "collection.granted",
      principalId: principalId.trim(),
      actor,
      detail: { collection: collection.trim() },
    });
    return await snapshot();
  } catch (e) {
    return fail(e, "Could not grant that collection.");
  }
}

export async function revokeCollectionAction(
  collection: string,
  principalId: string,
): Promise<Result<AccessSnapshot>> {
  const actor = await operator();
  if (!actor) return { error: DENIED };
  try {
    const ok = await revokeCollectionGrant(collection, principalId);
    if (!ok) return { error: "That grant no longer exists." };
    await recordAuthEvent({
      event: "collection.revoked",
      principalId,
      actor,
      detail: { collection },
    });
    return await snapshot();
  } catch (e) {
    return fail(e, "Could not revoke that grant.");
  }
}
