import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";

/*
 * Authenticating what arrives at /api/teams/messages.
 *
 * The endpoint is a public URL on the internet. Anything that can POST to it
 * can ask the hub to run an agent, so this file is the boundary, and it is
 * worth being precise about what it does and does not establish:
 *
 *   IT PROVES the request came from the Bot Framework service, addressed to
 *   this bot. The token is signed by Microsoft, and its audience is our app id.
 *
 *   IT DOES NOT PROVE who typed the message. The sender is a field in the
 *   activity body, not a claim in the token. Identity is resolved separately
 *   (identity.ts) by asking the connector who that member is and matching them
 *   against `principals` — a Teams user the hub does not know gets no run.
 *
 * Verification is done with node:crypto rather than a JWT library. RS256 over
 * two base64url segments is a handful of lines, `createPublicKey` reads a JWK
 * directly, and the alternative is a dependency in the one place where "what
 * exactly does this check" should be readable end to end in one file.
 *
 * Four claims are checked, and each one is load-bearing:
 *
 *   iss         must be Microsoft's issuer, so a token from another tenant's
 *               login endpoint cannot be replayed here.
 *   aud         must be OUR app id. Without it, any valid Bot Framework token
 *               — including one minted for somebody else's bot — is accepted.
 *   exp / nbf   with a small skew, so a captured token stops working.
 *   serviceUrl  must match the activity's own serviceUrl when the claim is
 *               present. This is the subtle one: the reply address is taken
 *               from the request body, and without this check an attacker who
 *               got hold of a valid token could point the bot's replies — and
 *               its bot token — at a host they control.
 */

const ISSUER = "https://api.botframework.com";

/** Where the Bot Framework publishes its signing keys. Overridable for tests. */
const OPENID_URL =
  process.env.TEAMS_OPENID_URL ?? "https://login.botframework.com/v1/.well-known/openidconfiguration";

/** Tolerated clock difference between Microsoft's clock and ours. */
const SKEW_SECONDS = 300;

export type VerifyResult = { ok: true; appId: string } | { ok: false; error: string };

interface Jwks {
  keys: (JsonWebKey & { kid?: string; kty?: string })[];
}

// The key set changes rarely and rotates without warning, so it is cached with
// a short life and re-fetched on an unknown kid rather than on a timer alone.
let cached: { keys: Jwks["keys"]; fetchedAt: number } | null = null;
const KEYS_TTL_MS = 60 * 60 * 1000;

async function signingKeys(force = false): Promise<Jwks["keys"]> {
  if (!force && cached && Date.now() - cached.fetchedAt < KEYS_TTL_MS) return cached.keys;
  const metaRes = await fetch(OPENID_URL);
  if (!metaRes.ok) throw new Error(`Could not read the Bot Framework OpenID metadata (${metaRes.status}).`);
  const meta = (await metaRes.json()) as { jwks_uri?: string };
  if (!meta.jwks_uri) throw new Error("The Bot Framework OpenID metadata has no jwks_uri.");
  const keysRes = await fetch(meta.jwks_uri);
  if (!keysRes.ok) throw new Error(`Could not read the Bot Framework signing keys (${keysRes.status}).`);
  const jwks = (await keysRes.json()) as Jwks;
  cached = { keys: jwks.keys ?? [], fetchedAt: Date.now() };
  return cached.keys;
}

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;

/**
 * Verify the `Authorization` header on an inbound activity.
 *
 * `activityServiceUrl` is the serviceUrl from the request body; pass it so the
 * token can be bound to the address the reply will be sent to.
 */
export async function verifyInboundToken(
  authorization: string | null,
  activityServiceUrl: string | undefined,
): Promise<VerifyResult> {
  const appId = process.env.TEAMS_APP_ID;
  if (!appId) {
    // Refuse rather than skip. An endpoint that accepts anything because it is
    // unconfigured is worse than one that is switched off.
    return { ok: false, error: "TEAMS_APP_ID is not set — this endpoint is not configured, so nothing is accepted." };
  }

  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return { ok: false, error: "No bearer token." };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "Malformed token." };
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(rawHeader);
    claims = decodeSegment(rawPayload);
  } catch {
    return { ok: false, error: "Token header or payload is not readable JSON." };
  }

  // Pinned, not read from the token: "alg" is attacker-controlled, and honouring
  // it is how the `none` and HMAC-confusion attacks work.
  if (header.alg !== "RS256") return { ok: false, error: `Unexpected signing algorithm ${String(header.alg)}.` };

  let keys = await signingKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await signingKeys(true); // rotation, most likely
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, error: `No published signing key matches kid ${String(header.kid)}.` };

  let verified = false;
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    verified = createVerify("RSA-SHA256")
      .update(`${rawHeader}.${rawPayload}`)
      .verify(key, Buffer.from(rawSignature, "base64url"));
  } catch (err) {
    return { ok: false, error: `Signature could not be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!verified) return { ok: false, error: "Signature does not match." };

  if (claims.iss !== ISSUER) return { ok: false, error: `Wrong issuer: ${String(claims.iss)}.` };

  // Microsoft sends `aud` as a string; accept the array form defensively.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(appId)) {
    return { ok: false, error: "This token was issued for a different bot." };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp + SKEW_SECONDS < now) {
    return { ok: false, error: "Token has expired." };
  }
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_SECONDS > now) {
    return { ok: false, error: "Token is not valid yet." };
  }

  if (typeof claims.serviceurl === "string" || typeof claims.serviceUrl === "string") {
    const claimed = String(claims.serviceurl ?? claims.serviceUrl).replace(/\/+$/, "");
    if (claimed !== (activityServiceUrl ?? "").replace(/\/+$/, "")) {
      return { ok: false, error: "The token was issued for a different serviceUrl than this activity names." };
    }
  }

  return { ok: true, appId };
}
