# Authentication

The hub is an OAuth 2.1 **protected resource**. WorkOS AuthKit is the
**authorization server**. The hub issues no OAuth tokens and holds no client
secret — it publishes its resource metadata and verifies the access tokens that
come back.

That split is the point of increment 01. It is what lets an enterprise AI
surface enrol the hub without a bespoke integration, and it is what turns
"who can reach our knowledge base" from a secret in an environment variable into
a row an operator can disable.

## Three ways in

| Source | What it is | Revoke by |
|---|---|---|
| `oauth` | An AuthKit access token. The front door — every human surface can get one. | Disabling the person in `/admin` |
| `credential` | A `hub_sk_…` token issued from `/admin`. The service door, for clients that cannot do OAuth: CI, cron, hub-to-hub. | Revoking it in `/admin` |
| `env` | The legacy `HUB_API_TOKENS` map. **Deprecated.** | A deploy (this is the problem) |

All three resolve to the same `Principal`, so nothing downstream knows or cares
which door a request came through. `authenticate()` routes by the *shape* of the
token — a JWT can only be AuthKit, `hub_sk_…` can only be a credential — so one
failed lookup is never logged as three.

## Why the env map had to go

`HUB_API_TOKENS` is a JSON blob of hand-minted secrets. It cannot be read back
once deployed, it cannot be revoked without a deploy, and **each deploy replaces
the whole map**.

On 6 September 2026, adding one colleague cost ~45 minutes of downtime across
four deploys. Deploying `.env.local` over production revoked everything that
existed only in production — three live tokens, one after another — and because
`hub/.env.local` still held the `.env.example` placeholders, `tok-admin` granted
admin on `hub.teqneo.co` for roughly 31 minutes (Fly release 14 → 16).

Now price that for a 200-person client. The token model was never a weakness to
patch later; it was the thing standing between the hub and every enterprise
surface, because **both of them require OAuth before they will scan a single
tool**.

## Configuration

```
WORKOS_AUTHKIT_DOMAIN=https://your-app.authkit.app   # issuer + JWKS origin
HUB_MCP_RESOURCE=https://hub.teqneo.co/api/mcp        # RFC 8707 resource indicator
HUB_BASE_URL=https://hub.teqneo.co                    # public origin
```

`HUB_MCP_RESOURCE` must match the Resource Indicator configured in the WorkOS
dashboard **exactly**, or every token fails on `aud`. It defaults to
`<HUB_BASE_URL>/api/mcp`. It is explicit configuration rather than something
rebuilt per request because behind Fly the `Host` header is the container's own
bind address — a resource indicator of `https://0.0.0.0:3000/api/mcp` matches
nothing.

In the WorkOS dashboard (Connect → Configuration):

1. Enable **Dynamic Client Registration**, so MCP clients can register
   themselves. Without it every client needs a hand-made client id.
2. Enable **Client ID Metadata Document**.
3. Set the **Resource Indicator** to the same URL as `HUB_MCP_RESOURCE`.

Leaving `WORKOS_AUTHKIT_DOMAIN` unset is a supported state: OAuth is simply off,
the discovery routes answer 404 with a reason, and the hub stays reachable by
credential. It fails closed either way — an unverifiable token is never trusted.

## What the hub publishes

| Path | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 metadata: the resource id and its authorization server |
| `/.well-known/oauth-protected-resource/api/mcp` | The same document at the path-aware location; clients in the wild request both |
| `/.well-known/oauth-authorization-server` | AuthKit's own metadata, proxied, for older clients that skip RFC 9728 |

An unauthenticated `POST /api/mcp` answers `401` with:

```
WWW-Authenticate: Bearer error="unauthorized", error_description="Authorization needed",
                  resource_metadata="https://hub.teqneo.co/.well-known/oauth-protected-resource"
```

That header is the whole discovery chain: a client that has never seen this hub
reads it, fetches the metadata, finds AuthKit, and registers itself.

`/.well-known` is listed as public in `middleware.ts`. It has to be — a sign-in
redirect in front of discovery would make the hub undiscoverable by every
surface, because the client would follow the 307 and parse an HTML login page as
metadata.

## Identity is not authorization

An access token proves *who* the holder is — a WorkOS user id and an email. It
says nothing about what they may do here. Roles come from the `principals`
table, looked up by WorkOS user id, falling back to email.

This is deliberate. An access token that could carry its own authorization would
make every scope WorkOS ever adds a potential privilege escalation into the hub.
A person nobody has granted anything gets nothing, and the refusal is recorded
as `auth.denied / no_principal` — which is the event that tells an operator
someone is waiting to be let in.

The email fallback is what lets access be granted *before* its owner has ever
signed in: an admin creates the row with an email, and the first token that
arrives binds the WorkOS user id to it permanently. Once bound, the binding wins
over the address — so a re-assigned email address cannot inherit anyone's access.

## The browser door

The web UI resolves a person exactly as the token path above does: **by a
`principals` row**, and roles come from that row only
(`apps/web/src/lib/sessionPrincipal.ts`).

1. **`ALLOWED_EMAILS` first.** Who may sign in at all. It is **required**:
   unset or empty lets nobody in. There used to be a built-in fallback, the
   two founders' accounts, which gave Teqneo admin on any hub deployed without
   the variable (docs/data-protection-review.md, F4). That fallback is gone.
2. **Then a row**, matched on WorkOS user id or email. A disabled row gets
   nothing.
3. **No row** gets nothing either. The layout tells the person nobody has
   given them access yet. It used to make them admin, without a row or a
   trace. There are two exceptions, and both are on the audit trail:
   - a domain in `HUB_AUTO_PROVISION_DOMAINS` gets an `analyst` row
     (`principal.provisioned`);
   - **an empty hub**, one with no enabled admin, makes its first allowlisted
     person to sign in its admin (`principal.bootstrap`). That happens once.

The access console (`/admin`: people, credentials, collection grants, audit)
requires the **admin** role on every action. It used to require only a place
on the allowlist. That was written when the allowlist was the founders alone;
once it held everyone, any viewer could have made themselves an admin.

## Signing in once

The goal: a person adds the hub to Claude Code, signs in in the browser, and
everything works — the hub's knowledge and agents, and the PM-tool as
themselves. Two pieces make that true.

**Naming the person.** A WorkOS access token carries no email — only `sub`
([token claims](https://workos.com/docs/authkit/connect/token-claims)). After a
first sign-in the row is bound to that id and matched by it alone. On the first
sign-in the hub asks WorkOS who `sub` is (`packages/authz/src/directory.ts`,
needs `WORKOS_API_KEY`) and matches the email against the rows an admin made;
a token a JWT template has given an email claim skips the call. A person
WorkOS cannot name is refused as `no_email`, distinct from `no_principal`, so
the operator knows whether to fix the key or add the person.

**Provisioning.** An OAuth sign-in from an email domain listed in
`HUB_AUTO_PROVISION_DOMAINS` creates the person's `principals` row on the spot
(id = their email, display name from WorkOS, role `analyst`, audit event
`principal.provisioned`) instead of bouncing with `no_principal`. Off unless
set; admin is never granted this way; a disabled row still refuses; roles
afterwards come from the row, so an admin grant made later sticks. Everyone
outside the listed domains is refused exactly as before.

**Pass-through.** An OAuth principal carries their own access token
(`Principal.accessToken`), and the hub dials remote servers that opted in with
`forwardIdentity: true` using it instead of the hub's machine token — on
`/api/mcp`, where those servers' tools are served directly under the person's
identity, and on `/api/mcp/agents/<slug>` and in hub-run agent turns started by
that person. Opt-in because the token is valid at the hub itself: a server that
receives it could act as the person here, so only servers we vouch for — the
PM-tool — get it, and a person sees no tools from one that does not. The PM-tool sees the person, offers
what they may do there, and audits the call as theirs. A read-only entry
(`pm-tool-read`) stays read-only: the hub keeps only tools the upstream marks
`readOnlyHint: true` (`lib/mcp/proxyTools.ts`). The PM-tool has to accept
tokens issued for the hub's resource — `MCP_TRUSTED_AUDIENCES` on its side.

What keeps using the machine token, because there is no person to speak as: a
`hub_sk_…` credential, a schedule, and (for now) the browser console's agent
chat, whose WorkOS session token is for the web app rather than the MCP
resource.

`npm run verify:identity -w web` covers all of it against tokens the script
signs itself (48 checks, no WorkOS).

## Credentials

Issued from `/admin`, which is gated on the WorkOS session rather than on a
bearer token. That is the bootstrap: the console that issues credentials cannot
itself require one, or the first credential could never be issued. The browser
door — AuthKit plus the email allowlist — is the root of trust, and it is one a
person can always get back through.

- The secret is **not stored**. The database holds a SHA-256 and the non-secret
  `hub_sk_xxxxxxxx` prefix, so a database dump yields nothing usable and the
  console can still name a credential. A lost credential is revoked and
  reissued, never recovered.
- A credential may **narrow** its owner's roles, never widen them. Compared by
  permitted *action*, not by role name: `viewer`'s actions are a strict subset
  of `analyst`'s, so an analyst scoping a credential to viewer is a real
  narrowing. A credential minted before a demotion cannot outlive it.
- Disabling a principal takes **every credential they hold** out of service at
  once. That is the break-glass control for a missing laptop, when you do not
  yet know which token was on it.
- Revocation takes effect on the next request. No deploy, no restart.

## The audit trail

`auth_events` records credentials issued and revoked, principals changed, and
every authentication that **failed**. Successful calls are deliberately not one
row each: `/api/mcp` authenticates on every JSON-RPC call, and a row per call
would make the audit log the hottest table in the database while burying the
events anyone actually reads. Success updates `api_credentials.last_used_at`
instead, coarsened to a minute.

A denial records the token *prefix*, never the secret — enough to identify a
revoked credential still sitting in someone's config file.

## Migrating off `HUB_API_TOKENS`

The env map still resolves, on purpose: production is running on it, and cutting
it mid-migration would lock the operator out of the console they need in order
to issue its replacement. `/admin` shows how many entries it still carries, and
the migration is not finished until that is zero.

1. Sign in to `/admin` with an allowlisted account.
2. Create a principal for each id in the current map (`admin`, `analyst`,
   `viewer`, `lead`, `ditlev-brygmann`), with the same roles and `agentId`.
3. Issue a credential per client. Copy each one at the moment it is shown.
4. Update every client: `~/.claude.json`, CI, and the `PM_TOOL_MCP_TOKEN` /
   `HUB_REMOTE_MCP_SERVERS` side.
5. Confirm the audit trail shows each new credential being used, and that
   `last_used_at` is populated for all of them.
6. Set `HUB_DISABLE_LEGACY_TOKENS=1`. Confirm nothing broke.
7. Delete the `HUB_API_TOKENS` Fly secret.

Do steps 6 and 7 as separate deploys. Step 6 is reversible by an environment
variable; step 7 is not reversible at all.

## Verifying

```
npm run verify:credentials -w @ai-hub/authz
```

No API key and no network. It covers the token format, the credential
lifecycle, role narrowing, expiry, revocation, the disable switch, every
rejection path, and the audit writes — under throwaway principals it cleans up
after itself.

What it does **not** cover, because it needs a real AuthKit tenant: that a
genuine access token verifies and maps to a principal. The harness proves the
rejection half — that nothing else gets in. Signing a JWT with a key we made up
would only prove `jose` can verify our own key.
