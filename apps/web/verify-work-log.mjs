// Verification of the work-log hook — scripts/hub-work-log.mjs, which sends
// what a Claude Code session committed to a skill on the hub when the session
// ends.
//
//   node apps/web/verify-work-log.mjs
//
// No hub, no database, no token of yours. A throwaway git repository stands in
// for the project and a throwaway HTTP server for the hub's /api/mcp; the real
// script runs as the hooks would run it, with the hook's JSON on stdin.
//
// What matters most: a session that committed nothing sends nothing (the hook
// must not cost a model run per session); the token travels only in the
// Authorization header, never in the body; and nothing the hub does — refuse,
// vanish, answer slowly — can fail the session.
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const script = fileURLToPath(new URL("../../scripts/hub-work-log.mjs", import.meta.url));
const TOKEN = "hub_sk_fixture_token";

// ── the throwaway hub ───────────────────────────────────────────────────────
const calls = [];
let answer = { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"status":"running","runId":"r1"}' }] } } };
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  calls.push({ path: req.url, authorization: req.headers.authorization, accept: req.headers.accept, body: raw });
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(JSON.stringify(answer.body));
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const hubUrl = `http://127.0.0.1:${http.address().port}`;

// ── the throwaway project ───────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "hub-work-log-"));
const project = join(root, "project");
const state = join(root, "state");
mkdirSync(project);
const git = (...a) => execFileSync("git", a, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
git("init", "-q", "-b", "feature/decks");
git("config", "user.email", "verify@example.test");
git("config", "user.name", "Verify");
git("remote", "add", "origin", "git@github.com:teqneo/hub.git");
writeFileSync(join(project, "README.md"), "before\n");
git("add", ".");
git("commit", "-q", "-m", "Earlier work, before the session");

const transcript = join(root, "transcript.jsonl");
writeFileSync(
  transcript,
  [
    JSON.stringify({ type: "user", message: { content: "build the thing" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: the deck tray is live. Left out: PDF export." }] } }),
  ].join("\n") + "\n",
);

const run = (mode, { env = {}, input = {} } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, mode], {
      cwd: root,
      env: { ...process.env, HUB_URL: hubUrl, HUB_TOKEN: TOKEN, HUB_WORK_LOG_STATE: state, CLAUDE_PROJECT_DIR: project, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr: stderr.trim() }));
    child.stdin.end(JSON.stringify({ session_id: "sess-1", transcript_path: transcript, cwd: project, hook_event_name: mode === "--start" ? "SessionStart" : "SessionEnd", ...input }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ── no start recorded ──────────────────────────────────────────────────────
  const cold = await run("--hook");
  check("a session with no recorded start sends nothing and says why", cold.code === 0 && calls.length === 0 && /no session start recorded/.test(cold.stderr), cold.stderr);

  // ── start, then nothing committed ─────────────────────────────────────────
  const started = await run("--start");
  check("--start records the session, outside the project", started.code === 0 && existsSync(join(state, "sess-1.json")) && !existsSync(join(project, ".claude")));
  const quiet = await run("--hook");
  check("a session that committed nothing sends nothing, silently", quiet.code === 0 && calls.length === 0 && quiet.stderr === "", quiet.stderr);
  check("and the session record is consumed", !existsSync(join(state, "sess-1.json")));

  // ── start, commit twice, end ───────────────────────────────────────────────
  await run("--start");
  await sleep(1100); // git --since has one-second resolution
  writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "Add the deck tray\n\nSlides an agent adds land in the tray first.\n\nLeft out: PDF export.");
  writeFileSync(join(project, "b.ts"), "export const b = 2;\n");
  git("add", ".");
  git("commit", "-q", "-m", "Fix the tray count");
  writeFileSync(join(project, "c.ts"), "uncommitted\n");
  const sent = await run("--hook");
  check("a session with commits sends exactly one call", sent.code === 0 && calls.length === 1, sent.stderr);
  const call = calls[0];
  const rpc = call ? JSON.parse(call.body) : {};
  check("to the hub's MCP endpoint, as a tools/call of the skill's tool", call?.path === "/api/mcp" && rpc.method === "tools/call" && rpc.params?.name === "hub_skill_pm_work_log", rpc.params?.name);
  check("with the token in the Authorization header and the MCP accept header", call?.authorization === `Bearer ${TOKEN}` && /text\/event-stream/.test(call?.accept ?? ""));
  check("and never in the body", !call?.body.includes(TOKEN));
  const log = rpc.params?.arguments?.log ?? "";
  check("the log names the repository and branch from git", rpc.params?.arguments?.repo === "teqneo/hub" && rpc.params?.arguments?.branch === "feature/decks" && /Repository: teqneo\/hub \(branch feature\/decks\)/.test(log));
  check("it carries this session's commits, subject and body, and not the earlier one", /Add the deck tray/.test(log) && /Slides an agent adds land in the tray first/.test(log) && /Fix the tray count/.test(log) && !/Earlier work/.test(log) && /Commits in this session \(2\)/.test(log));
  check("it counts what was left uncommitted", /Uncommitted changes left in the working tree: 1 file/.test(log));
  check("it carries the assistant's last text message from the transcript, not a tool call", /Done: the deck tray is live\. Left out: PDF export\./.test(log) && !/tool_use/.test(log));
  check("stderr says where the result goes", /sent 2 commit\(s\) on teqneo\/hub to pm-work-log/.test(sent.stderr) && /\/approvals/.test(sent.stderr), sent.stderr);

  // ── a huge commit body is cut, not sent whole ──────────────────────────────
  calls.length = 0;
  await run("--start");
  await sleep(1100);
  writeFileSync(join(project, "d.ts"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", `Huge\n\n${"y".repeat(40_000)}`);
  await run("--hook");
  const bigLog = JSON.parse(calls[0]?.body ?? "{}").params?.arguments?.log ?? "";
  check("a log over the hub's inline limit is cut at 18000 characters and says so", bigLog.length < 18_100 && /\[cut at 18000 characters\]/.test(bigLog), String(bigLog.length));

  // ── the hub misbehaves: the session is never failed ────────────────────────
  calls.length = 0;
  answer = { status: 200, body: { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Unknown tool: hub_skill_pm_work_log" }] } } };
  await run("--start");
  await sleep(1100);
  writeFileSync(join(project, "e.ts"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "More");
  const refused = await run("--hook");
  check("a refusal from the hub is one line on stderr and exit 0", refused.code === 0 && /refused hub_skill_pm_work_log/.test(refused.stderr), refused.stderr);

  answer = { status: 401, body: { error: "Unauthorized" } };
  await run("--start");
  await sleep(1100);
  writeFileSync(join(project, "f.ts"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "More again");
  const denied = await run("--hook");
  check("a 401 is one line on stderr and exit 0", denied.code === 0 && /hub answered 401/.test(denied.stderr), denied.stderr);

  await run("--start");
  await sleep(1100);
  writeFileSync(join(project, "g.ts"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "Yet more");
  const gone = await run("--hook", { env: { HUB_URL: "http://127.0.0.1:9" } });
  check("an unreachable hub is one line on stderr and exit 0", gone.code === 0 && /could not reach/.test(gone.stderr), gone.stderr);

  // ── switched off, and a different skill ───────────────────────────────────
  calls.length = 0;
  answer = { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } } };
  await run("--start");
  await sleep(1100);
  writeFileSync(join(project, "h.ts"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "Off");
  const off = await run("--hook", { env: { HUB_WORK_LOG: "off" } });
  check("HUB_WORK_LOG=off sends nothing", off.code === 0 && calls.length === 0);
  await run("--start");
  writeFileSync(join(project, "i.ts"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "Elsewhere");
  await run("--hook", { env: { HUB_WORK_LOG_SKILL: "atlas-work-log" } });
  check("HUB_WORK_LOG_SKILL picks the receiving skill", JSON.parse(calls[0]?.body ?? "{}").params?.name === "hub_skill_atlas_work_log", JSON.parse(calls[0]?.body ?? "{}").params?.name);

  // ── not a git repository ───────────────────────────────────────────────────
  const plain = join(root, "plain");
  mkdirSync(plain);
  calls.length = 0;
  const notGit = await run("--hook", { env: { CLAUDE_PROJECT_DIR: plain }, input: { cwd: plain } });
  check("a directory that is not a repository sends nothing", notGit.code === 0 && calls.length === 0 && notGit.stderr === "");

  check("the state directory holds no leftover session records", readdirSync(state).length === 0, readdirSync(state).join(", "));
} finally {
  http.close();
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} checks FAILED` : `\nWork-log hook OK (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
