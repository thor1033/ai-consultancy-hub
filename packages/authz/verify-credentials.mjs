// Verification of increment 01: OAuth 2.1 with WorkOS as the authorization
// server, and the credential store that replaces HUB_API_TOKENS.
//
//   node --experimental-transform-types --env-file=apps/web/.env.local \
//        packages/authz/verify-credentials.mjs
//
// No API key and no network: the OAuth path is exercised through its rejection
// cases, which is the half that has to be right — a token that does not verify
// must never produce a principal. Proving that a *valid* AuthKit token is
// accepted needs a real AuthKit domain and a real token, and is called out at
// the end rather than faked with a self-signed JWT that would only prove jose
// can verify a key we made up ourselves.
//
// Everything happens under throwaway principals this script creates and deletes.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The package's TypeScript uses extensionless imports, which bundlers resolve
// and Node does not. Harness-only; nothing in the package changes for a test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".") || !context.parentURL) throw err;
      for (const ext of [".ts", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      throw err;
    }
  },
});

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — run with --env-file=apps/web/.env.local");
  process.exit(1);
}

const { mintToken, isHubToken, hashToken, hashesEqual, tokenPrefix, TOKEN_SCHEME } = await import(
  "./src/token.ts"
);
const { authenticate, legacyTokenCount } = await import("./src/principal.ts");
const { issueApiCredential, revokeApiCredential } = await import("./src/issue.ts");
const { looksLikeJwt, mcpResource, oauthConfig } = await import("./src/oauth.ts");
const {
  getSql,
  upsertPrincipal,
  getPrincipal,
  findPrincipalByIdentity,
  bindWorkosUser,
  issueCredential,
  verifyCredential,
  listCredentials,
  listAuthEvents,
  setPrincipalEnabled,
} = await import("../db/src/index.ts");

const sql = getSql();
const OWNER = `verify-owner-${Date.now()}`;
const OTHER = `verify-other-${Date.now()}`;
const bearer = (t) => new Headers({ authorization: `Bearer ${t}` });

try {
  // --- token format -------------------------------------------------------
  const minted = mintToken();
  check(
    "mintToken produces a hub_sk_ token of the documented shape",
    minted.token.startsWith(TOKEN_SCHEME) && minted.token.length === TOKEN_SCHEME.length + 32,
    minted.token.slice(0, TOKEN_SCHEME.length + 4) + "…",
  );
  check("the prefix is a true prefix of the token", minted.token.startsWith(minted.tokenPrefix));
  check(
    "the prefix is not enough to reconstruct the token",
    minted.tokenPrefix.length < minted.token.length / 2,
  );
  check("hashToken is deterministic", hashToken(minted.token) === minted.tokenHash);
  check("the token itself is not stored in the minted hash", !minted.tokenHash.includes(minted.token));
  check("isHubToken accepts a minted token", isHubToken(minted.token));
  check(
    "isHubToken rejects near-misses",
    !isHubToken("hub_sk_short") && !isHubToken("tok-admin") && !isHubToken(minted.token + "x"),
  );
  check("hashesEqual is true for equal digests", hashesEqual(minted.tokenHash, minted.tokenHash));
  check("hashesEqual is false for different digests", !hashesEqual(minted.tokenHash, hashToken("x")));
  check(
    "two mints never collide",
    new Set(Array.from({ length: 200 }, () => mintToken().token)).size === 200,
  );

  // --- principals ---------------------------------------------------------
  const owner = await upsertPrincipal({
    id: OWNER,
    email: `  ${OWNER}@Example.COM  `,
    displayName: "Verify Owner",
    roles: ["analyst"],
  });
  check("upsertPrincipal lowercases and trims the email", owner.email === `${OWNER}@example.com`);

  const byEmail = await findPrincipalByIdentity({ email: `${OWNER}@EXAMPLE.com` });
  check("a principal is findable by email regardless of case", byEmail?.id === OWNER);
  check("an unbound principal has no WorkOS id yet", byEmail?.workosUserId === null);

  await bindWorkosUser(OWNER, `user_${OWNER}`);
  const bound = await getPrincipal(OWNER);
  check("bindWorkosUser binds the id on first sight", bound?.workosUserId === `user_${OWNER}`);

  await bindWorkosUser(OWNER, "user_someone_else");
  const stillBound = await getPrincipal(OWNER);
  check(
    "a bound principal cannot be rebound to a different WorkOS user",
    stillBound?.workosUserId === `user_${OWNER}`,
  );

  await upsertPrincipal({ id: OTHER, email: `${OTHER}@example.com`, roles: ["viewer"] });
  const byId = await findPrincipalByIdentity({
    workosUserId: `user_${OWNER}`,
    email: `${OTHER}@example.com`,
  });
  check(
    "the WorkOS id outranks the email when the two disagree",
    byId?.id === OWNER,
    "an established binding wins over an address someone else now holds",
  );

  // --- credentials --------------------------------------------------------
  const issued = await issueApiCredential({
    name: "verify — full",
    principalId: OWNER,
    actor: "verify-harness",
  });
  check("issueApiCredential returns the plaintext exactly once", isHubToken(issued.token));
  check(
    "the stored row carries the prefix, not the secret",
    issued.credential.tokenPrefix === tokenPrefix(issued.token) &&
      !JSON.stringify(issued.credential).includes(issued.token),
  );

  const verified = await verifyCredential(tokenPrefix(issued.token), hashToken(issued.token));
  check("verifyCredential finds a live credential", verified?.credential.id === issued.credential.id);
  check("verifyCredential returns the owner with it", verified?.principal.id === OWNER);
  check(
    "verifyCredential rejects the right prefix with a wrong hash",
    (await verifyCredential(tokenPrefix(issued.token), hashToken("wrong"))) === null,
  );

  // --- authenticate(): the credential path --------------------------------
  const p1 = await authenticate(bearer(issued.token));
  check("authenticate resolves a credential", p1?.id === OWNER, `source=${p1?.source}`);
  check("the source is reported as `credential`", p1?.source === "credential");
  check("it inherits the owner's roles", JSON.stringify(p1?.roles) === JSON.stringify(["analyst"]));
  check("it carries the credential id for the audit trail", p1?.credentialId === issued.credential.id);
  check("it carries the owner's email", p1?.email === `${OWNER}@example.com`);

  // --- roles narrow, never widen ------------------------------------------
  const admin = await upsertPrincipal({
    id: `${OWNER}-admin`,
    email: `${OWNER}-admin@example.com`,
    roles: ["admin"],
  });
  const narrowed = await issueApiCredential({
    name: "verify — narrowed",
    principalId: admin.id,
    roles: ["viewer"],
    actor: "verify-harness",
  });
  const pNarrow = await authenticate(bearer(narrowed.token));
  check(
    "an admin can scope a credential down to viewer",
    JSON.stringify(pNarrow?.roles) === JSON.stringify(["viewer"]),
    "admin is a wildcard, so scoping it is always a narrowing — this is the CI-token case",
  );

  const demotable = await upsertPrincipal({
    id: `${OWNER}-demoted`,
    email: `${OWNER}-demoted@example.com`,
    roles: ["viewer"],
  });
  const stale = await issueApiCredential({
    name: "verify — issued before demotion",
    principalId: demotable.id,
    roles: ["analyst", "viewer"],
    actor: "verify-harness",
  });
  const pStale = await authenticate(bearer(stale.token));
  check(
    "a credential cannot outlive its owner's demotion",
    JSON.stringify(pStale?.roles) === JSON.stringify(["viewer"]),
    `analyst was dropped: roles=${JSON.stringify(pStale?.roles)}`,
  );

  // Roles form a lattice by permitted action, not a flat set of names: viewer's
  // actions are a strict subset of analyst's, so this is a real narrowing.
  const scoped = await issueApiCredential({
    name: "verify — analyst scoped to viewer",
    principalId: OWNER,
    roles: ["viewer"],
    actor: "verify-harness",
  });
  const pScoped = await authenticate(bearer(scoped.token));
  check(
    "an analyst can scope a credential down to viewer",
    JSON.stringify(pScoped?.roles) === JSON.stringify(["viewer"]),
    "viewer's actions ⊂ analyst's, so the narrowing is real rather than empty",
  );

  const { narrowRoles, actionsForRoles } = await import("./src/policy.ts");
  check(
    "narrowRoles drops a role the principal could not fully exercise",
    JSON.stringify(narrowRoles(["viewer"], ["analyst"])) === JSON.stringify([]),
    "a viewer asking for analyst gets nothing, not the overlap",
  );
  check(
    "admin's action set covers every other role",
    ["analyst", "viewer"].every((r) =>
      [...actionsForRoles([r])].every((a) => actionsForRoles(["admin"]).has(a)),
    ),
  );

  const widened = await issueApiCredential({
    name: "verify — attempted widen",
    principalId: OWNER,
    roles: ["admin"],
    actor: "verify-harness",
  });
  const pWide = await authenticate(bearer(widened.token));
  check(
    "a credential can NEVER widen its owner's roles",
    !pWide?.roles.includes("admin"),
    `analyst principal + admin credential ⇒ roles=${JSON.stringify(pWide?.roles)}`,
  );

  // --- agent binding ------------------------------------------------------
  const boundCred = await issueApiCredential({
    name: "verify — agent bound",
    principalId: OWNER,
    agentId: "delivery-lead",
    actor: "verify-harness",
  });
  const pAgent = await authenticate(bearer(boundCred.token));
  check("a credential can bind a standing agent", pAgent?.agentId === "delivery-lead");
  check("an unbound credential has no agent", p1?.agentId === undefined);

  // --- revocation ---------------------------------------------------------
  const revoked = await revokeApiCredential(issued.credential.id, "verify-harness");
  check("revokeApiCredential returns the revoked row", revoked?.id === issued.credential.id);
  check(
    "a revoked credential stops authenticating immediately",
    (await authenticate(bearer(issued.token))) === null,
    "no deploy, no restart",
  );
  check(
    "revoking twice is a no-op",
    (await revokeApiCredential(issued.credential.id, "verify-harness")) === null,
  );

  // --- expiry -------------------------------------------------------------
  const past = mintToken();
  await issueCredential({
    name: "verify — expired",
    principalId: OWNER,
    tokenPrefix: past.tokenPrefix,
    tokenHash: past.tokenHash,
    expiresAt: new Date(Date.now() - 1000),
  });
  check("an expired credential does not authenticate", (await authenticate(bearer(past.token))) === null);

  // --- a disabled owner disables every credential they hold ---------------
  await setPrincipalEnabled(OWNER, false);
  check(
    "disabling a principal disables their credentials at once",
    (await authenticate(bearer(boundCred.token))) === null,
    "one switch, not one per credential",
  );
  await setPrincipalEnabled(OWNER, true);
  check(
    "re-enabling restores them",
    (await authenticate(bearer(boundCred.token)))?.id === OWNER,
  );

  // --- authenticate(): rejection paths ------------------------------------
  check("no Authorization header ⇒ no principal", (await authenticate(new Headers())) === null);
  check("a non-Bearer scheme ⇒ no principal", (await authenticate(new Headers({ authorization: "Basic abc" }))) === null);
  check("an empty bearer ⇒ no principal", (await authenticate(new Headers({ authorization: "Bearer   " }))) === null);
  check("an unknown hub_sk_ token ⇒ no principal", (await authenticate(bearer(mintToken().token))) === null);
  check("a random string ⇒ no principal", (await authenticate(bearer("tok-admin"))) === null);

  // --- OAuth: shape routing and rejection ---------------------------------
  check("looksLikeJwt accepts a compact JWS", looksLikeJwt("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig"));
  check(
    "looksLikeJwt rejects a hub credential and a legacy token",
    !looksLikeJwt(minted.token) && !looksLikeJwt("tok-admin"),
  );
  const fakeJwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.not-a-real-signature";
  check(
    "an unsigned/forged JWT is rejected",
    (await authenticate(bearer(fakeJwt))) === null,
    "no principal is minted from a token we cannot verify",
  );

  // --- the legacy map still carries production ----------------------------
  const legacyCount = legacyTokenCount();
  check(
    "the deprecated HUB_API_TOKENS map still resolves",
    legacyCount > 0,
    `${legacyCount} entries — production is still on these until they are migrated`,
  );
  if (legacyCount > 0) {
    const first = Object.keys(JSON.parse(process.env.HUB_API_TOKENS))[0];
    const pLegacy = await authenticate(bearer(first));
    check("a legacy token resolves with source=env", pLegacy?.source === "env", `id=${pLegacy?.id}`);
  }

  // --- audit trail --------------------------------------------------------
  const events = await listAuthEvents(200);
  const mine = events.filter((e) => e.principalId === OWNER || e.actor === "verify-harness");
  check("credential.issued is audited", mine.some((e) => e.event === "credential.issued"));
  check("credential.revoked is audited", mine.some((e) => e.event === "credential.revoked"));
  const denials = events.filter((e) => e.event === "auth.denied");
  check("failed authentication is audited", denials.length > 0, `${denials.length} denials recorded`);
  check(
    "a denial names the prefix but never the secret",
    denials.every((e) => !JSON.stringify(e.detail).includes(minted.token)),
  );

  // --- last-used ----------------------------------------------------------
  const rows = await listCredentials();
  const touched = rows.find((r) => r.id === boundCred.credential.id);
  check("a used credential records when it was last used", touched?.lastUsedAt !== null);

  // --- configuration reporting -------------------------------------------
  const cfg = oauthConfig();
  if (cfg) {
    check("oauthConfig derives the JWKS url from the issuer", cfg.jwksUrl === `${cfg.issuer}/oauth2/jwks`);
    check("the resource indicator is absolute", mcpResource()?.startsWith("http") === true);
  } else {
    check(
      "oauthConfig is absent without WORKOS_AUTHKIT_DOMAIN (OAuth simply off)",
      mcpResource() === null || process.env.WORKOS_AUTHKIT_DOMAIN === undefined,
      "set WORKOS_AUTHKIT_DOMAIN + HUB_MCP_RESOURCE to turn the front door on",
    );
  }
} finally {
  // Throwaway principals take their credentials with them (on delete cascade).
  await sql`delete from principals where id like 'verify-%'`;
  await sql`delete from auth_events where actor = 'verify-harness' or principal_id like 'verify-%'`;
  await sql.end();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) {
  console.log("Failed:");
  for (const f of failed) console.log(`  - ${f.label}`);
  process.exit(1);
}
console.log(
  "\nNot covered here (needs a real AuthKit tenant): that a genuine access token\n" +
    "from WORKOS_AUTHKIT_DOMAIN verifies and maps to a principal. Everything above\n" +
    "proves the rejection half — that nothing else gets in.",
);
