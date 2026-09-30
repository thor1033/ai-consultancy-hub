// Verification of the Teams channel — the hub's first inbound route, and the
// first path where something can leave the tenant.
//
//   node --experimental-transform-types --env-file=.env.local apps/web/verify-teams.mjs
//
// Needs DATABASE_URL (and a migrated database). No API key, no Azure Bot, no
// Microsoft tenant, no spend. Four throwaway HTTP servers stand in for the
// Bot Framework's key endpoint, the Bot Connector, the Messages API and
// Microsoft Graph, and a real RSA keypair signs real JWTs — so the token
// checks are exercised against genuine signatures rather than a stub that
// agrees with itself.
//
// Everything below the fixtures is the shipping path: verifyInboundToken,
// handleActivity, runAgentForPrincipal, the real microsoft365 MCP server as a
// child process, the approvals store, and sendApprovedDraft. What is being
// checked is the seam between them:
//
//   a Teams user the hub does not know gets no run at all
//   a run that drafts a mail parks an approval and posts a card
//   Approve sends, and records what was ACTUALLY sent
//   a second Approve sends nothing
//   Reject sends nothing
//   with no send credential, Approve says so instead of failing silently
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

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
      if (!specifier.startsWith(".") || !context.parentURL) throw err;
      for (const ext of [".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
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
  console.error("DATABASE_URL is not set — run with --env-file=.env.local");
  process.exit(1);
}

const APP_ID = "bot-app-id-1234";
const MAILBOX = "secretary@example.com";
const SERVICE_URL_PATH = "/connector";
const CONVERSATION = "19:channel_abc@thread.tacv2";
const TEAMS_USER = "29:user-thor";

// ── a real keypair, so the signature checks mean something ───────────────────
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const KID = "fixture-key-1";

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function signJwt(claims, { alg = "RS256", kid = KID, sign = true } = {}) {
  const header = b64({ alg, kid, typ: "JWT" });
  const payload = b64(claims);
  if (!sign) return `${header}.${payload}.${Buffer.from("not-a-signature").toString("base64url")}`;
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const now = () => Math.floor(Date.now() / 1000);
const validClaims = (over = {}) => ({
  iss: "https://api.botframework.com",
  aud: APP_ID,
  exp: now() + 3600,
  nbf: now() - 60,
  serviceurl: "", // filled once the fixture port is known
  ...over,
});

// ── fixtures ─────────────────────────────────────────────────────────────────
const posted = [];        // what the bot said back to Teams
const graphCalls = [];    // every Graph request, from both credentials
let anthropicTurns = 0;
let draftedOnce = false;

const DRAFT_ID = "AAMkAGZ-draft-1";
const ANSWER = "I have written the reply to Anna. It is waiting in Drafts.";

const fixture = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const parsed = (() => {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  })();

  // --- the Bot Framework's published signing keys -----------------------------
  if (url.pathname === "/openid") {
    return json(200, { jwks_uri: `${origin}/keys` });
  }
  if (url.pathname === "/keys") {
    return json(200, { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] });
  }

  // --- token endpoints: the bot's, and both Graph credentials ----------------
  if (url.pathname.endsWith("/oauth2/v2.0/token")) {
    const form = new URLSearchParams(body);
    const scope = form.get("scope") ?? "";
    // The sending registration is a DIFFERENT client id; the fixture refuses a
    // Graph send token to the reading one, the way a tenant without Mail.Send
    // consent would.
    return json(200, { access_token: `token-for:${form.get("client_id")}:${scope}`, expires_in: 3600 });
  }

  // --- the Bot Connector -----------------------------------------------------
  if (url.pathname.startsWith(SERVICE_URL_PATH)) {
    const rest = url.pathname.slice(SERVICE_URL_PATH.length);
    const roster = rest.match(/^\/v3\/conversations\/[^/]+\/members\/(.+)$/);
    if (roster) {
      const userId = decodeURIComponent(roster[1]);
      if (userId === TEAMS_USER) return json(200, { id: userId, name: "Thor Simonsen", email: KNOWN_EMAIL });
      if (userId === "29:user-stranger") return json(200, { id: userId, name: "A Visitor", email: "visitor@elsewhere.example" });
      return json(404, { error: "no such member" });
    }
    const update = rest.match(/^\/v3\/conversations\/[^/]+\/activities\/(.+)$/);
    if (update && req.method === "PUT") {
      posted.push({ kind: "replace", activityId: decodeURIComponent(update[1]), activity: parsed });
      return json(200, { id: decodeURIComponent(update[1]) });
    }
    if (rest.match(/^\/v3\/conversations\/[^/]+\/activities$/) && req.method === "POST") {
      const id = `activity-${posted.length + 1}`;
      posted.push({ kind: "post", activityId: id, activity: parsed });
      return json(201, { id });
    }
    return json(404, { error: `no connector route for ${rest}` });
  }

  // --- the Messages API ------------------------------------------------------
  if (url.pathname === "/v1/messages") {
    anthropicTurns++;
    const wantsDraft = !draftedOnce && JSON.stringify(parsed).includes("m365_mail_draft");
    if (wantsDraft) {
      draftedOnce = true;
      return json(200, {
        id: `msg_${anthropicTurns}`, type: "message", role: "assistant", model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Writing the reply now." },
          {
            type: "tool_use", id: "toolu_draft_1", name: "m365_mail_draft",
            input: { replyTo: "msg-reschedule", body: "Friday 10:00 works from my side." },
          },
        ],
        stop_reason: "tool_use", stop_sequence: null,
        usage: { input_tokens: 400, output_tokens: 60 },
      });
    }
    return json(200, {
      id: `msg_${anthropicTurns}`, type: "message", role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "text", text: ANSWER }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 30 },
    });
  }

  // --- Microsoft Graph -------------------------------------------------------
  if (url.pathname.startsWith(`/users/${encodeURIComponent(MAILBOX)}`)) {
    const rest = url.pathname.slice(`/users/${encodeURIComponent(MAILBOX)}`.length);
    graphCalls.push({ method: req.method, path: rest, auth: req.headers.authorization, sent: parsed });

    if (req.method === "POST" && /^\/messages\/[^/]+\/createReply$/.test(rest)) {
      return json(201, {
        id: DRAFT_ID,
        subject: "RE: Can we move Thursday?",
        toRecipients: [{ emailAddress: { name: "Anna Holm", address: "anna@example.com" } }],
        ccRecipients: [],
        conversationId: "conv-1",
        webLink: "https://outlook.office365.com/mail/drafts/id/AAMk",
        isDraft: true,
      });
    }
    if (req.method === "GET" && rest === `/messages/${encodeURIComponent(DRAFT_ID)}`) {
      return json(200, {
        // Edited in Outlook after it was proposed — the send path must notice.
        subject: "RE: Can we move Thursday? (Friday 10:00)",
        toRecipients: [{ emailAddress: { address: "anna@example.com" } }],
        ccRecipients: [],
        isDraft: !sendFixtureHasSent,
      });
    }
    if (req.method === "POST" && rest === `/messages/${encodeURIComponent(DRAFT_ID)}/send`) {
      // Only the SENDING registration may send here. The reading one gets the
      // 403 a tenant without Mail.Send consent would give.
      if (!String(req.headers.authorization).includes(SEND_CLIENT_ID)) {
        return json(403, { error: { code: "ErrorAccessDenied", message: "Access is denied." } });
      }
      sendFixtureHasSent = true;
      return json(202, {});
    }
    if (req.method === "GET" && rest === "") {
      return json(200, { displayName: "Secretary", mail: MAILBOX, userPrincipalName: MAILBOX });
    }
    return json(404, { error: { code: "ResourceNotFound", message: `no graph route for ${rest}` } });
  }

  return json(404, { error: `no fixture route for ${url.pathname}` });
});

const KNOWN_EMAIL = `verify-teams-${Date.now()}@example.com`;
const SEND_CLIENT_ID = "sending-registration";
let sendFixtureHasSent = false;

await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const SERVICE_URL = `${origin}${SERVICE_URL_PATH}`;

// ── environment: every outbound call points at the fixture ───────────────────
Object.assign(process.env, {
  TEAMS_APP_ID: APP_ID,
  TEAMS_APP_PASSWORD: "bot-password",
  TEAMS_OPENID_URL: `${origin}/openid`,
  TEAMS_LOGIN_BASE_URL: origin,
  TEAMS_AGENT: "", // filled in below, once the throwaway agent has a slug
  M365_TENANT_ID: "tenant",
  M365_CLIENT_ID: "reading-registration",
  M365_CLIENT_SECRET: "reading-secret",
  M365_MAILBOX: MAILBOX,
  M365_LOGIN_BASE_URL: origin,
  M365_GRAPH_BASE_URL: origin,
  M365_TIMEZONE: "Europe/Copenhagen",
  ANTHROPIC_BASE_URL: origin,
  ANTHROPIC_API_KEY: "fixture-key",
  HUB_REMOTE_MCP_SERVERS: "",
});
delete process.env.LANGFUSE_PUBLIC_KEY;
// The sending credential starts ABSENT on purpose: the first Approve must
// degrade honestly rather than throw.
delete process.env.M365_SEND_TENANT_ID;
delete process.env.M365_SEND_CLIENT_ID;
delete process.env.M365_SEND_CLIENT_SECRET;

const { verifyInboundToken } = await import("./src/lib/teams/auth.ts");
const { handleActivity, withoutMention } = await import("./src/lib/teams/handler.ts");
const { draftsInTranscript } = await import("./src/lib/teams/drafts.ts");
const { createAgent, deleteAgent } = await import("../../packages/db/src/agents.ts");
const { upsertPrincipal, setPrincipalEnabled } = await import("../../packages/db/src/credentials.ts");
const { listApprovals, getApproval } = await import("../../packages/db/src/approvals.ts");

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const stamp = Date.now();
const principalId = `verify-teams-${stamp}`;
let agent = null;

const activity = (over = {}) => ({
  type: "message",
  id: `inbound-${randomUUID()}`,
  serviceUrl: SERVICE_URL,
  conversation: { id: CONVERSATION },
  from: { id: TEAMS_USER, name: "Thor Simonsen" },
  recipient: { id: "28:bot", name: "Secretary" },
  ...over,
});

const lastSaid = () => [...posted].reverse().find((p) => p.kind === "post" && p.activity.text)?.activity.text ?? "";
const cards = () => posted.filter((p) => p.kind === "post" && p.activity.attachments?.length);

try {
  // ── the token ──────────────────────────────────────────────────────────────
  const good = signJwt(validClaims({ serviceurl: SERVICE_URL }));
  check("a properly signed Bot Framework token is accepted", (await verifyInboundToken(`Bearer ${good}`, SERVICE_URL)).ok);

  const wrongAudience = signJwt(validClaims({ aud: "someone-elses-bot", serviceurl: SERVICE_URL }));
  const audOutcome = await verifyInboundToken(`Bearer ${wrongAudience}`, SERVICE_URL);
  check("a token minted for another bot is refused", !audOutcome.ok, audOutcome.error);

  const expired = signJwt(validClaims({ exp: now() - 4000, serviceurl: SERVICE_URL }));
  check("an expired token is refused", !(await verifyInboundToken(`Bearer ${expired}`, SERVICE_URL)).ok);

  const unsigned = signJwt(validClaims({ serviceurl: SERVICE_URL }), { sign: false });
  check("a token whose signature does not verify is refused", !(await verifyInboundToken(`Bearer ${unsigned}`, SERVICE_URL)).ok);

  const noneAlg = signJwt(validClaims({ serviceurl: SERVICE_URL }), { alg: "none", sign: false });
  const noneOutcome = await verifyInboundToken(`Bearer ${noneAlg}`, SERVICE_URL);
  check('alg "none" is refused — the algorithm is pinned, not read from the token', !noneOutcome.ok, noneOutcome.error);

  const wrongIssuer = signJwt(validClaims({ iss: "https://evil.example", serviceurl: SERVICE_URL }));
  check("a token from another issuer is refused", !(await verifyInboundToken(`Bearer ${wrongIssuer}`, SERVICE_URL)).ok);

  // The subtle one: the reply address comes from the request body, so a valid
  // token must not be usable to point the bot's replies somewhere else.
  const elsewhere = await verifyInboundToken(`Bearer ${good}`, "https://attacker.example");
  check("a valid token cannot be replayed against a different serviceUrl", !elsewhere.ok, elsewhere.error);

  check("no bearer token at all is refused", !(await verifyInboundToken(null, SERVICE_URL)).ok);

  // ── stripping the mention ──────────────────────────────────────────────────
  check(
    "the @mention is stripped before the agent reads the question",
    withoutMention("<at>Secretary</at> what is on today?", "Secretary") === "what is on today?",
    withoutMention("<at>Secretary</at> what is on today?", "Secretary"),
  );
  check("a mention on its own leaves nothing to ask", withoutMention("<at>Secretary</at>", "Secretary") === "");

  // ── who is speaking ────────────────────────────────────────────────────────
  agent = await createAgent({
    slug: `verify-teams-${stamp}`,
    name: "Verify Secretary",
    instructions: "You are a test double.",
    mcpServers: [{ name: "microsoft365" }],
  });
  process.env.TEAMS_AGENT = agent.slug;
  await upsertPrincipal({ id: principalId, email: KNOWN_EMAIL, displayName: "Thor Simonsen", roles: ["analyst"] });

  const strangerBefore = posted.length;
  const stranger = await handleActivity(activity({ text: "<at>Secretary</at> what is on today?", from: { id: "29:user-stranger", name: "A Visitor" } }));
  await stranger.background;
  check(
    "a Teams user the hub does not know gets no run, and is told why",
    /do not have an account/i.test(lastSaid()),
    lastSaid().slice(0, 70),
  );
  check("and nothing was asked of the model on their behalf", anthropicTurns === 0, `${anthropicTurns} model turn(s)`);
  check("they still get an answer rather than silence", posted.length > strangerBefore);

  await setPrincipalEnabled(principalId, false);
  const disabled = await handleActivity(activity({ text: "<at>Secretary</at> anything for me?" }));
  await disabled.background;
  check("a disabled principal is refused too", /disabled/i.test(lastSaid()), lastSaid().slice(0, 60));
  await setPrincipalEnabled(principalId, true);

  // ── a real turn, which writes a draft ──────────────────────────────────────
  const handled = await handleActivity(activity({ text: "<at>Secretary</at> reply to Anna and say Friday 10:00 works" }));
  check("a message is handled as a message", handled.kind === "message", handled.kind);
  await handled.background;

  check("the agent's answer is posted back into the thread", posted.some((p) => p.activity.text === ANSWER));
  check("the model was actually called", anthropicTurns >= 2, `${anthropicTurns} turns`);
  check(
    "the draft was written through the real MCP server, against Graph",
    graphCalls.some((c) => c.method === "POST" && /createReply$/.test(c.path)),
    graphCalls.map((c) => `${c.method} ${c.path}`).join(" | ").slice(0, 80),
  );

  const [approval] = await listApprovals({ state: "pending", limit: 10 }).then((rows) =>
    rows.filter((r) => r.requestedBy === principalId),
  );
  check("the draft is parked as a pending approval", Boolean(approval), approval?.summary);
  check(
    "the approval carries the literal draft id, not a description of it",
    approval?.action?.draftId === DRAFT_ID,
    String(approval?.action?.draftId),
  );
  check("it is attributed to the person who asked, not to the hub", approval?.requestedBy === principalId);

  const card = cards().at(-1);
  check("a card is posted into the thread", Boolean(card), card?.activity.text);
  const actions = card?.activity.attachments?.[0]?.content?.actions ?? [];
  check(
    "with an Approve and a Reject on it, both naming this approval",
    actions.length === 2 && actions.every((x) => x.data.approvalId === approval.id),
    actions.map((x) => x.title).join(" / "),
  );
  check(
    "the card says plainly that nothing has been sent",
    JSON.stringify(card?.activity.attachments?.[0]?.content ?? {}).includes("nothing has been sent"),
  );
  const stampedOrigin = (await getApproval(approval.id))?.origin;
  check(
    "the card's own activity id is stamped on the approval, so it can be replaced",
    Boolean(stampedOrigin?.activityId) && stampedOrigin.activityId === card?.activityId,
    String(stampedOrigin?.activityId),
  );

  // ── Approve, with no sending credential configured ─────────────────────────
  const graphBefore = graphCalls.length;
  const noCredential = await handleActivity(
    activity({ text: "", value: { approvalId: approval.id, decision: "approved" } }),
  );
  check("a card press is handled as a decision, not as a question", noCredential.kind === "decision");
  await noCredential.background;

  const after = await getApproval(approval.id);
  check("the decision is recorded even though the send could not happen", after.state === "approved", after.state);
  check(
    "and the failure is recorded against it, naming what is missing",
    /M365_SEND/.test(after.failure ?? ""),
    (after.failure ?? "").slice(0, 70),
  );
  check("it stays approved — a send that failed is not a rejection", after.state === "approved");
  check("nothing was sent", !graphCalls.slice(graphBefore).some((c) => /\/send$/.test(c.path)));
  check(
    "the person is told the draft is still in Outlook",
    /Outlook/i.test(JSON.stringify(posted.slice(-2))),
  );

  // ── a second press changes nothing ─────────────────────────────────────────
  const again = await handleActivity(activity({ value: { approvalId: approval.id, decision: "approved" } }));
  await again.background;
  check(
    "pressing Approve again says it was already decided rather than sending",
    /already/i.test(JSON.stringify(posted.slice(-2))),
  );

  // ── now with a sending credential ──────────────────────────────────────────
  Object.assign(process.env, {
    M365_SEND_TENANT_ID: "tenant",
    M365_SEND_CLIENT_ID: SEND_CLIENT_ID,
    M365_SEND_CLIENT_SECRET: "sending-secret",
  });

  const { createApproval } = await import("../../packages/db/src/approvals.ts");
  const second = await createApproval({
    kind: "mail.send",
    requestedBy: principalId,
    summary: "Reply to Anna Holm",
    action: { draftId: DRAFT_ID, to: ["anna@example.com"], subject: "RE: Can we move Thursday?", preview: "Friday works." },
    origin: { kind: "teams", conversationId: CONVERSATION, serviceUrl: SERVICE_URL },
  });

  const sent = await handleActivity(activity({ value: { approvalId: second.id, decision: "approved" } }));
  await sent.background;

  const sendCall = graphCalls.find((c) => /\/send$/.test(c.path));
  check("Approve sends the draft", Boolean(sendCall), sendCall?.path);
  check(
    "and it is the SENDING registration's token that sends it, not the agent's",
    String(sendCall?.auth).includes(SEND_CLIENT_ID),
    String(sendCall?.auth).slice(0, 40),
  );

  const sentRow = await getApproval(second.id);
  check("what was actually sent is recorded, not what was proposed", Boolean(sentRow.result?.sentAt), JSON.stringify(sentRow.result ?? {}).slice(0, 60));
  check(
    "a draft edited in Outlook after approval is sent as edited, and flagged",
    sentRow.result?.subject === "RE: Can we move Thursday? (Friday 10:00)" && sentRow.result?.editedAfterProposal === true,
    String(sentRow.result?.subject),
  );
  check("the send is recorded as carried out", sentRow.carriedOutAt !== null && sentRow.failure === null);

  // ── Reject ─────────────────────────────────────────────────────────────────
  const third = await createApproval({
    kind: "mail.send",
    requestedBy: principalId,
    summary: "Reply declining the call",
    action: { draftId: "draft-never-sent", to: ["someone@example.com"], subject: "No thanks", preview: "…" },
  });
  const sendsBefore = graphCalls.filter((c) => /\/send$/.test(c.path)).length;
  const rejected = await handleActivity(activity({ value: { approvalId: third.id, decision: "rejected" } }));
  await rejected.background;
  const thirdRow = await getApproval(third.id);
  check("Reject records the rejection", thirdRow.state === "rejected", thirdRow.state);
  check("and sends nothing", graphCalls.filter((c) => /\/send$/.test(c.path)).length === sendsBefore);
  check("the thread is told what happened", /rejected|nothing was sent/i.test(JSON.stringify(posted.slice(-2))));

  // ── the card is replaced, not left with live buttons ───────────────────────
  check(
    "a decided card is replaced in place",
    posted.some((p) => p.kind === "replace"),
    `${posted.filter((p) => p.kind === "replace").length} replacement(s)`,
  );
  const replacement = posted.filter((p) => p.kind === "replace").at(-1);
  check(
    "and the replacement has no buttons left to press",
    !(replacement?.activity.attachments?.[0]?.content?.actions ?? []).length,
  );

  // ── reading drafts out of a transcript ─────────────────────────────────────
  const failedCall = draftsInTranscript([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "m365_mail_draft", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Tool error: 403" }] },
  ]);
  check("a failed draft call does not become an approval", failedCall.length === 0);

  const twice = draftsInTranscript([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "m365_mail_draft", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: JSON.stringify({ draftId: "d1", subject: "s" }) }] }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "m365_mail_draft", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: JSON.stringify({ draftId: "d1", subject: "s" }) }] }] },
  ]);
  check("the same draft written twice is one approval, not two", twice.length === 1, `${twice.length}`);

  const otherTool = draftsInTranscript([
    { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "m365_mail_list", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: JSON.stringify({ draftId: "not-a-draft-call" }) }] },
  ]);
  check("another tool's output is not mistaken for a draft", otherTool.length === 0);

  // ── the invariant, across everything this run did ──────────────────────────
  const sendsFromAgent = graphCalls.filter((c) => /\/send$/.test(c.path) && !String(c.auth).includes(SEND_CLIENT_ID));
  check(
    "nothing using the agent's credential ever reached a send endpoint",
    sendsFromAgent.length === 0,
    `${sendsFromAgent.length} attempt(s)`,
  );
} finally {
  if (agent) await deleteAgent(agent.id).catch(() => {});
  await sql`delete from approvals where requested_by = ${principalId}`.catch(() => {});
  await sql`delete from agent_sessions where principal_id = ${principalId}`.catch(() => {});
  await sql`delete from principals where id = ${principalId}`.catch(() => {});
  await sql.end();
  fixture.close();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(
  failedChecks.length === 0
    ? `\nTeams channel OK (${checks.length} checks)`
    : `\nTeams channel FAILED (${failedChecks.length}/${checks.length})`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
