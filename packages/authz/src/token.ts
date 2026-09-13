import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The hub's own bearer credential format.
 *
 * OAuth is the front door — every human surface should arrive with an AuthKit
 * access token. These exist for the clients that cannot do OAuth at all: CI, a
 * cron job, one hub calling another. They are the direct replacement for the
 * HUB_API_TOKENS map, and unlike it they are rows, which is what makes them
 * revocable without a deploy.
 *
 * Shape: `hub_sk_<32 url-safe chars>`.
 *
 * The `hub_sk_` prefix is not decoration. It makes a leaked credential
 * recognisable in a log or a paste, it lets authentication route a presented
 * token to the right verifier without trying all of them, and the first 15
 * characters are stable and non-secret, so the console can name a credential
 * without ever holding the secret.
 */
export const TOKEN_SCHEME = "hub_sk_";

// 24 random bytes → 32 base64url characters. Well past the guessing budget of
// anything that can reach a public endpoint, and short enough to paste.
const SECRET_BYTES = 24;

// `hub_sk_` + 8 characters. Long enough to be unique in practice (the column is
// unique, so a collision is a retry, not a corruption) and short enough that the
// remaining 24 characters still carry the secret.
const PREFIX_LENGTH = TOKEN_SCHEME.length + 8;

const TOKEN_PATTERN = new RegExp(`^${TOKEN_SCHEME}[A-Za-z0-9_-]{32}$`);

export interface MintedToken {
  /** The full secret. Shown to the operator once, at issue, and never stored. */
  token: string;
  /** The non-secret leading slice, stored and displayed. */
  tokenPrefix: string;
  /** SHA-256 of the full token, hex. What the database holds. */
  tokenHash: string;
}

export function mintToken(): MintedToken {
  const token = TOKEN_SCHEME + randomBytes(SECRET_BYTES).toString("base64url");
  return { token, tokenPrefix: tokenPrefix(token), tokenHash: hashToken(token) };
}

export function isHubToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LENGTH);
}

/**
 * SHA-256, hex.
 *
 * A fast hash rather than a password KDF, deliberately. bcrypt/argon2 exist to
 * make a *low-entropy* human-chosen secret expensive to guess; this secret is
 * 24 random bytes, so there is nothing to guess and the only thing a slow hash
 * would buy is latency on every single MCP call. What matters here is that the
 * plaintext is not recoverable from a database dump, and SHA-256 gives that.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Verification normally compares hashes inside Postgres, where this is moot.
 * Exported for the paths that compare in process — the legacy env-var map —
 * so a token can never be recovered a character at a time from response timing.
 */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
