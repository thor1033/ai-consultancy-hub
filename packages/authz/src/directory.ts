/*
 * Who a WorkOS user id belongs to.
 *
 * A WorkOS OAuth access token names the person only by `sub` — there is no
 * email claim (https://workos.com/docs/authkit/connect/token-claims). The hub
 * keys people by email: an admin adds "alice@…" in /admin before Alice has ever
 * signed in, and the provisioning rule is a list of email domains. So on a
 * FIRST sign-in the hub has to ask WorkOS who `sub` is. Afterwards the row is
 * bound to the id and this is never consulted again for that person.
 *
 * Behind a seam so the verify scripts can stand in for WorkOS, and so the SDK
 * is loaded lazily: it is only needed on a first sign-in, and nothing reachable
 * from middleware or instrumentation should pull it into an edge bundle.
 *
 * Fails closed: no WORKOS_API_KEY, an unknown id, or a WorkOS error all yield
 * null, and a person the hub cannot name cannot be matched or provisioned.
 */

export interface DirectoryUser {
  email: string | null;
  /** Display name as WorkOS has it; empty when it has none. */
  name: string;
}

export interface UserDirectory {
  lookup(workosUserId: string): Promise<DirectoryUser | null>;
}

let warnedMissingKey = false;

function workosDirectory(): UserDirectory {
  return {
    async lookup(workosUserId) {
      const key = process.env.WORKOS_API_KEY?.trim();
      if (!key) {
        // Said once, not on every refused sign-in: the operator has to add the
        // key, and the audit trail already records each refusal as no_email.
        if (!warnedMissingKey) {
          console.warn("[authz] WORKOS_API_KEY is not set — first OAuth sign-ins cannot be resolved to an email.");
          warnedMissingKey = true;
        }
        return null;
      }
      try {
        const { WorkOS } = await import("@workos-inc/node");
        const user = await new WorkOS(key).userManagement.getUser(workosUserId);
        return {
          email: user.email?.trim().toLowerCase() || null,
          name: [user.firstName, user.lastName].filter(Boolean).join(" "),
        };
      } catch (err) {
        console.warn("[authz] WorkOS user lookup failed:", err instanceof Error ? err.message : err);
        return null;
      }
    },
  };
}

let directory: UserDirectory | undefined;

export function userDirectory(): UserDirectory {
  return (directory ??= workosDirectory());
}

/** Replace the directory — for verification only. Null restores WorkOS. */
export function setUserDirectory(replacement: UserDirectory | null): void {
  directory = replacement ?? undefined;
}
