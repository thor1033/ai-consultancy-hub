// A merged pull request proposing to close its PM task (docs/code-handoff.md).
//
//   node --experimental-transform-types verify-github-merge.mjs
//   node --experimental-transform-types --env-file=.env.local verify-github-merge.mjs
//
// Without DATABASE_URL it checks what needs none: the signature (a real HMAC,
// a forged one, a missing header, a body changed after signing); which events
// count (only a merged pull_request closed); reading `PM-Task:` lines (ids
// kept to safe characters, duplicates and a flood capped); which server the
// writes go to; and that the proposed writes are deterministic, so a
// redelivery asks for the same calls. With DATABASE_URL it drives the real
// route handler: a signed delivery records the two proposals and writes
// nothing to the PM tool, a redelivery proposes nothing new, and a forged one
// is refused. Fixtures are created and deleted here. No network: the PM
// server is registered from a stand-in config, never dialled.
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

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

const m = await import("./src/lib/github/mergedPr.ts");

const SECRET = "verify-secret";
const sign = (body, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
const PROJECT = "ca4749f1-624f-437c-9552-6031da90c5f9";

// ── the signature ───────────────────────────────────────────────────────────
{
  const body = JSON.stringify({ hello: "world" });
  check("GitHub's signature over the raw body is accepted", m.signatureValid(SECRET, body, sign(body)));
  check("a signature made with another secret is refused", !m.signatureValid(SECRET, body, sign(body, "other")));
  check("a body changed after signing is refused", !m.signatureValid(SECRET, body + " ", sign(body)));
  check("a missing or malformed header is refused, not thrown", !m.signatureValid(SECRET, body, null) && !m.signatureValid(SECRET, body, "sha1=abc") && !m.signatureValid(SECRET, body, "sha256=zz"));
  check("no secret, nothing is valid", !m.signatureValid("", body, sign(body, "")));
}

// ── which events count ──────────────────────────────────────────────────────
const prPayload = (over = {}) => ({
  action: "closed",
  repository: { full_name: "thor1033/PM-tool" },
  pull_request: {
    merged: true,
    number: 42,
    title: "Compact project projection",
    html_url: "https://github.com/thor1033/PM-tool/pull/42",
    merged_at: "2026-11-15T10:00:00Z",
    merged_by: { login: "thor1033" },
    body: `Adds a fields option.\n\nPM-Task: ${PROJECT}/t_duh2aci\n`,
    ...over,
  },
});
check("a merged pull request is read", m.readMergedPr("pull_request", prPayload())?.number === 42);
check("a closed but unmerged one is not", m.readMergedPr("pull_request", prPayload({ merged: false })) === null);
check("an opened one is not", m.readMergedPr("pull_request", { ...prPayload(), action: "opened" }) === null);
check("another event is not", m.readMergedPr("push", prPayload()) === null && m.readMergedPr(null, prPayload()) === null);
check("a malformed payload is not, and does not throw", m.readMergedPr("pull_request", null) === null && m.readMergedPr("pull_request", { action: "closed" }) === null);

// ── PM-Task lines ───────────────────────────────────────────────────────────
{
  const refs = m.taskRefs(`Intro\nPM-Task: ${PROJECT}/t_duh2aci\n  pm-task:  ${PROJECT.toUpperCase()} / t_other  \nPM-Task: ${PROJECT}/t_duh2aci`);
  check("task lines are read, case-insensitively, with spacing tolerated", refs.length === 2 && refs[1].taskId === "t_other" && refs[1].projectId === PROJECT);
  check("a task named twice is proposed once", refs.filter((r) => r.taskId === "t_duh2aci").length === 1);
  check("a line inside a sentence is not a task line", m.taskRefs(`See PM-Task: ${PROJECT}/t_x for context`).length === 0);
  check("ids with other characters are refused", m.taskRefs(`PM-Task: ${PROJECT}/t_x"; drop`).length === 0 && m.taskRefs("PM-Task: not-a-project!/t_x").length === 0);
  const flood = Array.from({ length: 12 }, (_, i) => `PM-Task: ${PROJECT}/t_${i}`).join("\n");
  check(`no more than ${m.MAX_TASKS_PER_PR} tasks per pull request`, m.taskRefs(flood).length === m.MAX_TASKS_PER_PR);
  check("no body, no tasks", m.taskRefs(null).length === 0 && m.taskRefs("").length === 0);
}

// ── which server ────────────────────────────────────────────────────────────
{
  const servers = [
    { name: "pm-tool", readOnly: false, configured: true },
    { name: "pm-tool-read", readOnly: true, configured: true },
    { name: "github", readOnly: true, configured: true },
  ];
  check("the one writable PM-tool server is chosen", m.pickPmServer(servers).name === "pm-tool");
  check("a configured name wins", m.pickPmServer([...servers, { name: "pm-tool-2", readOnly: false }], "pm-tool-2").name === "pm-tool-2");
  check("a configured read-only server is refused in words", /read-only/.test(m.pickPmServer(servers, "pm-tool-read").error ?? ""));
  check("a configured unknown server is refused", /not a registered server/.test(m.pickPmServer(servers, "nope").error ?? ""));
  check("two writable PM servers are ambiguous, not guessed", /Several/.test(m.pickPmServer([...servers, { name: "pm-tool-2", readOnly: false }]).error ?? ""));
  check("a server missing its credential is not chosen", /No PM-tool server/.test(m.pickPmServer([{ name: "pm-tool", readOnly: false, configured: false }]).error ?? ""));
}

// ── the writes ──────────────────────────────────────────────────────────────
{
  const pr = m.readMergedPr("pull_request", prPayload());
  const ref = m.taskRefs(pr.body)[0];
  const ws = m.writesFor(pr, ref);
  check("a merge proposes a note on the task and moving it to done", ws.length === 2 && ws[0].tool === "pm_add_note" && ws[1].tool === "pm_update_task" && ws[1].args.status === "done");
  check("the note is attached to the task and links the pull request", ws[0].args.taskId === "t_duh2aci" && ws[0].args.body.includes(pr.url) && ws[0].args.projectId === PROJECT);
  check("the reason names the PR and who merged it, and says when to reject", /thor1033\/PM-tool#42/.test(ws[1].reason) && /by thor1033/.test(ws[1].reason) && /reject if work remains/.test(ws[1].reason));
  check("the writes carry no clock, so a redelivery proposes the same calls", JSON.stringify(m.writesFor(pr, ref)) === JSON.stringify(ws) && !("date" in ws[0].args));
}

// ── with a database: the route itself ───────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log("\n  (no DATABASE_URL — the route handler, its proposals and the redelivery check were not driven)\n");
} else {
  process.env.HUB_GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.HUB_REMOTE_MCP_SERVERS = JSON.stringify({ "verify-pm-tool": { url: "http://127.0.0.1:9/mcp", label: "PM (stand-in)", tokenEnv: "VERIFY_PM_TOKEN" } });
  process.env.VERIFY_PM_TOKEN = "never-dialled";
  process.env.HUB_GITHUB_PM_SERVER = "verify-pm-tool";
  const { POST } = await import("./src/app/api/github/webhook/route.ts");
  const db = await import("../../packages/db/src/index.ts");
  const sql = db.getSql();
  const taskId = `t_verify_${Date.now()}`;
  const body = JSON.stringify(prPayload({ body: `PM-Task: ${PROJECT}/${taskId}` }));
  const deliver = (b, sig = sign(b), event = "pull_request") =>
    POST(new Request("http://hub.local/api/github/webhook", { method: "POST", body: b, headers: { "x-github-event": event, "x-hub-signature-256": sig } }));
  try {
    const forged = await deliver(body, sign(body, "wrong"));
    check("a forged delivery is refused with 401", forged.status === 401);
    const ping = await deliver("{}", sign("{}"), "ping");
    check("GitHub's ping is answered", ping.status === 200 && (await ping.json()).pong === true);
    const first = await (await deliver(body)).json();
    check("a signed merge records two proposals", first.ok && first.proposed.length === 2, JSON.stringify(first));
    const rows = await sql`select tool, status, server, agent_id, principal_id, reason from proposals where id = any(${first.proposed}::uuid[])`;
    check("they wait for a person: pending, on the PM server, no agent, no principal", rows.length === 2 && rows.every((r) => r.status === "pending" && r.server === "verify-pm-tool" && r.agent_id === null && r.principal_id === null));
    const again = await (await deliver(body)).json();
    check("a redelivery proposes nothing new", again.ok && again.proposed.length === 0 && again.alreadyHeld.length === 2, JSON.stringify(again));
    const unmerged = await (await deliver(JSON.stringify(prPayload({ merged: false })))).json();
    check("an unmerged close is acknowledged and ignored", unmerged.ok && /not a merged/.test(unmerged.ignored));
    delete process.env.HUB_GITHUB_WEBHOOK_SECRET;
    const off = await deliver(body);
    check("with no secret configured the endpoint is off, not open", off.status === 503);
  } finally {
    await sql`delete from proposals where args->>'taskId' = ${taskId}`.catch(() => {});
    await sql.end();
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ""}`);
process.exit(failed.length ? 1 : 0);
