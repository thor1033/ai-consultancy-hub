import {
  issueCredential,
  revokeCredential,
  recordAuthEvent,
  type CredentialRow,
} from "@ai-hub/db";
import { mintToken } from "./token";

/**
 * Issue and revoke credentials, with the audit write attached.
 *
 * Kept together so there is no way to mint a credential without recording that
 * it was minted. The env-var map it replaces had no such record at all — after
 * the 6 September incident the only way to answer "what did we just revoke?"
 * was to diff two deploys.
 */

export interface IssuedCredential {
  /**
   * The plaintext secret. Returned exactly once, at issue: the database holds
   * only a hash, so a credential that is lost has to be revoked and reissued.
   */
  token: string;
  credential: CredentialRow;
}

export interface IssueInput {
  name: string;
  principalId: string;
  roles?: string[];
  agentId?: string | null;
  expiresAt?: Date | null;
  /** Who is issuing it — the signed-in operator, for the audit trail. */
  actor: string;
}

export async function issueApiCredential(input: IssueInput): Promise<IssuedCredential> {
  const { token, tokenPrefix, tokenHash } = mintToken();

  const credential = await issueCredential({
    name: input.name,
    principalId: input.principalId,
    tokenPrefix,
    tokenHash,
    roles: input.roles ?? [],
    agentId: input.agentId ?? null,
    createdBy: input.actor,
    expiresAt: input.expiresAt ?? null,
  });

  await recordAuthEvent({
    event: "credential.issued",
    source: "credential",
    principalId: credential.principalId,
    credentialId: credential.id,
    actor: input.actor,
    detail: {
      name: credential.name,
      tokenPrefix: credential.tokenPrefix,
      roles: credential.roles,
      agentId: credential.agentId,
      expiresAt: credential.expiresAt,
    },
  });

  return { token, credential };
}

export async function revokeApiCredential(
  id: string,
  actor: string,
): Promise<CredentialRow | null> {
  const credential = await revokeCredential(id, actor);
  // A second revoke of the same credential is a no-op, not an event: the audit
  // trail should say what changed, and nothing did.
  if (!credential) return null;

  await recordAuthEvent({
    event: "credential.revoked",
    source: "credential",
    principalId: credential.principalId,
    credentialId: credential.id,
    actor,
    detail: { name: credential.name, tokenPrefix: credential.tokenPrefix },
  });

  return credential;
}
