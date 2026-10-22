// Verification of "sign in once and it works": a person's OAuth sign-in to the
// hub, auto-provisioned from their email domain, carried through to the systems
// the hub dials on their behalf.
//
//   node --experimental-transform-types --env-file=apps/web/.env.local \
//        apps/web/verify-identity.mjs
//
// No API key, no WorkOS: this script IS the authorization server. It generates
// a signing key, serves it as a JWKS, points WORKOS_AUTHKIT_DOMAIN at itself and
// mints access tokens with the hub's resource as audience — so what is under
// test is the hub's real verifier, the real principal resolution, and the real
// endpoints, against tokens that are valid in every way but who signed them.
//
// The PM-tool is the remote fixture (packages/mcp/remote-fixture), declared
// twice under one URL the way production declares pm-tool / pm-tool-read. Its
// pm_whoami reports which bearer reached it, which is the whole question.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = new URL("./src/", import.meta.url);
      for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier.slice(2) + ext, base);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".")) return nextResolve(`${specifier}.js`, context);
      if (!context.parentURL) throw err;
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

// --- the authorization server: this script -----------------------------------
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "verify-key", alg: "RS256", use: "sig" };
const issuerServer = createServer((req, res) => {
  if (req.url === "/oauth2/jwks") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => issuerServer.listen(0, "127.0.0.1", r));
const ISSUER = `http://127.0.0.1:${issuerServer.address().port}`;
const RESOURCE = "https://hub.example.test/api/mcp";
process.env.WORKOS_AUTHKIT_DOMAIN = ISSUER;
process.env.HUB_MCP_RESOURCE = RESOURCE;
delete process.env.HUB_AUTO_PROVISION_DOMAINS;

const stamp = Date.now();
const DOMAIN = `verify-${stamp}.example`;
async function mint({ sub, email, aud = RESOURCE, iss = ISSUER, expiresIn = "5m" }) {
  return new SignJWT({ email, org_id: "org_verify" })
    .setProtectedHeader({ alg: "RS256", kid: "verify-key" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}
const bearer = (token) => new Headers({ authorization: `Bearer ${token}` });

// --- the PM-tool: the remote fixture, declared as pm-tool and pm-tool-read ---
const FIXTURE_PORT = 8790 + Math.floor(Math.random() * 500);
const MACHINE_TOKEN = `hub-machine-${stamp}`;
process.env.HUB_REMOTE_MCP_SERVERS = JSON.stringify({
  "verify-pm": { url: `http://127.0.0.1:${FIXTURE_PORT}/mcp`, label: "PM-tool (fixture)", tokenEnv: "VERIFY_PM_TOKEN" },
  "verify-pm-read": { url: `http://127.0.0.1:${FIXTURE_PORT}/mcp`, label: "PM-tool (read-only)", tokenEnv: "VERIFY_PM_TOKEN" },
});
process.env.VERIFY_PM_TOKEN = MACHINE_TOKEN;
const fixture = spawn(
  process.execPath,
  [fileURLToPath(new URL("../../packages/mcp/remote-fixture/server.mjs", import.meta.url))],
  { env: { ...process.env, PORT: String(FIXTURE_PORT), PM_TOOL_MCP_TOKEN: MACHINE_TOKEN }, stdio: "pipe" },
);
await new Promise((resolve, reject) => {
  fixture.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  fixture.on("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  setTimeout(() => reject(new Error("fixture did not start")), 10_000);
});

const { authenticate, autoProvisionable } = await import("../../packages/authz/src/index.ts");
const { remoteServerReadOnly } = await import("../../packages/mcp/src/index.ts");
const { buildHubMcpServer } = await import("./src/lib/mcp/hubServer.ts");
const { buildAgentMcpServer } = await import("./src/lib/mcp/agentServer.ts");
const db = await import("../../packages/db/src/index.ts");
const sql = db.getSql();

const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
async function connect(server) {
  const client = new Client({ name: "verify", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}
const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), body: parse(r.content?.[0]?.text ?? "") };
};
const lastEvent = async (event, email) =>
  (await sql`select detail from auth_events where event = ${event} and detail->>'email' = ${email} order by at desc limit 1`)[0];

const made = { agents: [], principals: [] };
let exitCode = 0;

try {
  // --- the verifier itself ---------------------------------------------------
  const alice = `alice@${DOMAIN}`;
  const good = await mint({ sub: `user_alice_${stamp}`, email: alice });
  check("a token for another audience is refused", (await authenticate(bearer(await mint({ sub: "u", email: alice, aud: "https://elsewhere.test/api/mcp" })))) === null);
  check("a token from another issuer is refused", (await authenticate(bearer(await mint({ sub: "u", email: alice, iss: "http://127.0.0.1:1" })))) === null);
  check("an expired token is refused", (await authenticate(bearer(await mint({ sub: "u", email: alice, expiresIn: "-1m" })))) === null);

  // --- provisioning: off by default --------------------------------------
  check("the domain rule is off unless configured", !autoProvisionable(alice));
  const refused = await authenticate(bearer(good));
  check("a valid sign-in with no principal row is refused", refused === null);
  const denied = await lastEvent("auth.denied", alice);
  check("and lands on the audit trail as no_principal", denied?.detail?.reason === "no_principal", JSON.stringify(denied?.detail));

  // --- provisioning: on for the company domain -----------------------------
  process.env.HUB_AUTO_PROVISION_DOMAINS = `@${DOMAIN.toUpperCase()}, other.example`;
  check("the rule matches the domain, case- and @-insensitively", autoProvisionable(alice) && autoProvisionable(`Bob@${DOMAIN}`));
  check("and not a lookalike", !autoProvisionable(`alice@${DOMAIN}.evil`) && !autoProvisionable(`alice@sub.${DOMAIN}`));

  const first = await authenticate(bearer(good));
  made.principals.push(alice);
  check("the first sign-in from the domain is let in", first !== null);
  check("as an analyst, never more", JSON.stringify(first?.roles) === JSON.stringify(["analyst"]), JSON.stringify(first?.roles));
  check("under the email as its id", first?.id === alice && first?.email === alice);
  check("by OAuth, carrying the person's own token", first?.source === "oauth" && first?.accessToken === good);
  const row = await db.getPrincipal(alice);
  check("a principals row now exists", row?.email === alice && row?.enabled === true);
  check("bound to the WorkOS user id", row?.workosUserId === `user_alice_${stamp}`);
  const prov = await lastEvent("principal.provisioned", alice);
  check("provisioning is on the audit trail with its rule", prov?.detail?.rule === "HUB_AUTO_PROVISION_DOMAINS", JSON.stringify(prov?.detail));

  const before = await sql`select count(*)::int as n from auth_events where event = 'principal.provisioned' and detail->>'email' = ${alice}`;
  const second = await authenticate(bearer(await mint({ sub: `user_alice_${stamp}`, email: alice })));
  const after = await sql`select count(*)::int as n from auth_events where event = 'principal.provisioned' and detail->>'email' = ${alice}`;
  check("a second sign-in reuses the row rather than provisioning again", second?.id === alice && after[0].n === before[0].n);

  await db.upsertPrincipal({ id: alice, email: alice, roles: ["admin"] });
  const promoted = await authenticate(bearer(good));
  check("roles come from the row, not the rule: an admin grant sticks", promoted?.roles.includes("admin"));

  await db.setPrincipalEnabled(alice, false);
  check("a disabled person is refused even from the domain", (await authenticate(bearer(good))) === null);
  await db.setPrincipalEnabled(alice, true);
  await db.upsertPrincipal({ id: alice, email: alice, roles: ["analyst"] });

  const outsider = `mallory@not-${DOMAIN}`;
  check("a valid sign-in from another domain is still refused", (await authenticate(bearer(await mint({ sub: "user_mallory", email: outsider })))) === null);

  // --- identity through the hub's own door (/api/mcp) ----------------------
  const person = await authenticate(bearer(good));
  const hubAsPerson = await connect(await buildHubMcpServer(person));
  const personTools = await toolNames(hubAsPerson);
  check("a signed-in person is offered the PM-tool's tools on the hub endpoint", personTools.includes("pm_whoami") && personTools.includes("pm_list_projects"), personTools.filter((t) => t.startsWith("pm_")).join(", "));
  check("including writes — the least restrictive entry for the URL wins", personTools.includes("pm_create_task"));
  check("served once, though declared twice", personTools.filter((t) => t === "pm_whoami").length === 1);
  const who = await call(hubAsPerson, "pm_whoami");
  check("and the PM-tool sees THEIR token, not the hub's", who.body?.kind === "person" && who.body?.bearer === good, JSON.stringify(who.body).slice(0, 60));
  const created = await call(hubAsPerson, "pm_create_task", { projectId: "p-helios", title: "verify" });
  check("a write through the hub is attributed to the person", created.body?.created?.by === good);
  await hubAsPerson.close();

  const credential = { id: `verify-cred-${stamp}`, roles: ["analyst"], source: "credential" };
  const hubAsCredential = await connect(await buildHubMcpServer(credential));
  const credTools = await toolNames(hubAsCredential);
  check("a credential with no person behind it is offered no PM-tool tools", !credTools.some((t) => t.startsWith("pm_")));
  check("but keeps the hub's own", credTools.includes("hub_run_agent"));
  await hubAsCredential.close();

  // --- identity through a local agent's door (/api/mcp/agents/<slug>) --------
  check("an entry named *-read is read-only by default", remoteServerReadOnly("verify-pm-read") && !remoteServerReadOnly("verify-pm"));
  const mk = async (suffix, servers) => {
    const a = await db.createAgent({ name: `Verify ${suffix}`, slug: `verify-id-${suffix}-${stamp}`, instructions: "x", placement: "local", mcpServers: servers.map((name) => ({ name })) });
    made.agents.push(a.id);
    return a;
  };
  const lead = await mk("lead", ["verify-pm"]);
  const secretary = await mk("secretary", ["verify-pm-read"]);

  const leadAsPerson = await connect(await buildAgentMcpServer(person, lead));
  const leadTools = await toolNames(leadAsPerson);
  check("a read-write agent run by a person gets the person's full access", leadTools.includes("pm_create_task") && leadTools.includes("pm_list_projects"));
  const leadWho = await call(leadAsPerson, "pm_whoami");
  check("and acts as the person", leadWho.body?.bearer === good);
  await leadAsPerson.close();

  const secAsPerson = await connect(await buildAgentMcpServer(person, secretary));
  const secTools = await toolNames(secAsPerson);
  check("a read-only agent run by a person keeps the reads", secTools.includes("pm_list_projects") && secTools.includes("pm_whoami"), secTools.filter((t) => t.startsWith("pm_")).join(", "));
  check("and loses the writes the person could otherwise make", !secTools.includes("pm_create_task"));
  const secWho = await call(secAsPerson, "pm_whoami");
  check("while still acting as the person", secWho.body?.bearer === good);
  await secAsPerson.close();

  const secAsCredential = await connect(await buildAgentMcpServer(credential, secretary));
  const secCredWho = await call(secAsCredential, "pm_whoami");
  check("with no person, the agent falls back to the hub's machine token", secCredWho.body?.kind === "machine" && secCredWho.body?.bearer === MACHINE_TOKEN);
  check("and leaves write-filtering to the upstream, as before", (await toolNames(secAsCredential)).includes("pm_create_task"));
  await secAsCredential.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  for (const id of made.agents) await db.deleteAgent(id).catch(() => {});
  for (const id of made.principals) {
    await sql`delete from auth_events where principal_id = ${id} or detail->>'email' = ${id}`.catch(() => {});
    await sql`delete from principals where id = ${id}`.catch(() => {});
  }
  await sql`delete from auth_events where detail->>'email' like ${`%${DOMAIN}`}`.catch(() => {});
  fixture.kill();
  issuerServer.close();
  await sql.end({ timeout: 2 }).catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length || exitCode ? 1 : 0);
