import { findPrincipalByIdentity } from "@ai-hub/db";
import type { Principal } from "@ai-hub/authz";
import { member, type ThreadRef } from "./connector";

/*
 * Who is speaking in the channel.
 *
 * The inbound token proves Microsoft sent the request; it says nothing about
 * who typed. So identity is resolved here, and the rule is the same one
 * schedules follow: a run executes as a principal, never as the hub itself,
 * because retrieval is scoped to the caller's grants (docs/knowledge-access.md).
 * A channel is a room full of people the hub has never heard of, and without
 * this it would be a way to run agents with somebody else's reach.
 *
 * The address comes from the roster call rather than from the activity body.
 * `from.name` is a display name, and display names are neither unique nor
 * stable; the roster returns the work address, which is what `principals.email`
 * is keyed on and what the hub already treats as the allowlist key.
 *
 * Failing here is a refusal with a sentence a person can act on, never a silent
 * drop: someone talking to a bot that says nothing back assumes it is broken.
 */

export type Identified = { ok: true; principal: Principal; name: string } | { ok: false; reason: string };

export async function principalForTeamsUser(
  thread: ThreadRef,
  from: { id?: string; name?: string; aadObjectId?: string } | undefined,
): Promise<Identified> {
  if (!from?.id) return { ok: false, reason: "I could not tell who sent that message, so I have not run anything." };

  const who = await member(thread, from.id);
  const email = who?.email?.trim().toLowerCase();
  const name = who?.name || from.name || "you";

  if (!email) {
    return {
      ok: false,
      reason:
        "I could not read your work address from this conversation, so I do not know whose access to use. " +
        "That usually means the bot is missing permission to read the roster in this channel.",
    };
  }

  const row = await findPrincipalByIdentity({ email });
  if (!row) {
    return {
      ok: false,
      reason:
        `I do not have an account for ${email}, so there is no access for me to act with. ` +
        "Sign in at https://hub.teqneo.co once and ask again.",
    };
  }
  if (!row.enabled) {
    return { ok: false, reason: `The account for ${email} is disabled, so I cannot act on your behalf.` };
  }

  return {
    ok: true,
    name,
    principal: {
      id: row.id,
      roles: row.roles,
      source: "teams",
      ...(row.email ? { email: row.email } : {}),
      ...(row.agentId ? { agentId: row.agentId } : {}),
    },
  };
}
