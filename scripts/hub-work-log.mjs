#!/usr/bin/env node
// Tells the hub what a Claude Code session built, when the session ends, so
// the board keeps up with the work instead of being told about it later.
//
//   SessionStart:  node scripts/hub-work-log.mjs --start   records when the session began
//   SessionEnd:    node scripts/hub-work-log.mjs --hook    sends the log, if there is one
//
// The log is what git can vouch for: the repository and branch, every commit
// made since the session began (subject and body), how many files are still
// uncommitted, and the assistant's last message from the transcript. It goes
// to ONE skill on the hub as a tool call — by default `pm-work-log`, the
// Project Manager's — which reads the board and proposes the changes the work
// implies. Nothing is written by this script, and nothing the agent proposes
// lands without a person on /approvals (docs/approvals.md).
//
//   HUB_URL              the hub's origin (default https://hub.teqneo.co)
//   HUB_TOKEN            a hub_sk_… credential, or an OAuth access token. Optional
//                        where a proxy injects the hub's credential.
//   HUB_WORK_LOG_SKILL   which skill receives the log (default pm-work-log)
//   HUB_WORK_LOG=off     switches it off for a machine
//
// Never fails the session, never blocks it: a session with no commits sends
// nothing; an unreachable hub is one line on stderr. See docs/project-manager.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const hubUrl = (process.env.HUB_URL || "https://hub.teqneo.co").replace(/\/+$/, "");
const token = process.env.HUB_TOKEN?.trim();
const skill = (process.env.HUB_WORK_LOG_SKILL || "pm-work-log").trim();
const mode = process.argv.includes("--start") ? "start" : "end";

// The hub's MCP server caps an inline string argument at 20000 characters;
// anything longer has to go through hub_put_text. A work log that long is a
// transcript, not a log, so it is cut instead.
const MAX_LOG = 18_000;
const MAX_MESSAGE = 3_000;

const warn = (m) => process.stderr.write(`[hub-work-log] ${m}\n`);

if (process.env.HUB_WORK_LOG === "off") process.exit(0);

// Hooks receive one JSON object on stdin: session_id, transcript_path, cwd, …
async function readHookInput() {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const input = await readHookInput();
const sessionId = String(input.session_id ?? "").replace(/[^a-zA-Z0-9_-]/g, "") || "no-session";
const cwd = String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());

// Where SessionStart leaves the start time for SessionEnd: outside the
// project, so a hook installed at user level writes nothing into a repository
// it does not own.
const sessionsDir = join(process.env.HUB_WORK_LOG_STATE || join(homedir(), ".claude", "hub", "sessions"));
const sessionFile = join(sessionsDir, `${sessionId}.json`);

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

if (mode === "start") {
  try {
    mkdirSync(sessionsDir, { recursive: true });
    // The commit HEAD was at: "this session's commits" is the range from here,
    // which is exact where a timestamp is not (git's --since has one-second
    // resolution and the clock may move).
    writeFileSync(sessionFile, JSON.stringify({ startedAt: new Date().toISOString(), head: git("rev-parse", "HEAD"), cwd }));
  } catch (err) {
    warn(`could not record the session start (${err?.message ?? err}).`);
  }
  process.exit(0);
}

// ── the log ─────────────────────────────────────────────────────────────────

let startedAt = null;
let startHead = null;
try {
  if (existsSync(sessionFile)) {
    const record = JSON.parse(readFileSync(sessionFile, "utf8"));
    startedAt = record.startedAt ?? null;
    startHead = typeof record.head === "string" && /^[0-9a-f]{40}$/.test(record.head) ? record.head : null;
    rmSync(sessionFile, { force: true });
  }
} catch {
  /* a bad record is the same as none */
}

if (git("rev-parse", "--is-inside-work-tree") !== "true") process.exit(0);
if (!startedAt) {
  // The start hook was not installed when this session began: nothing says
  // which commits were this session's, and guessing would credit old work.
  warn("no session start recorded — nothing sent. The --start hook records it from the next session on.");
  process.exit(0);
}

const remote = git("remote", "get-url", "origin") ?? "";
const repo = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? (cwd.split(/[\\/]/).pop() || "repository");
const branch = git("rev-parse", "--abbrev-ref", "HEAD") ?? "unknown";
// Everything reachable from HEAD that was not at the session's start; the
// timestamp is the fallback for a repository that had no commit yet.
const range = startHead && git("cat-file", "-e", startHead) !== null ? [`${startHead}..HEAD`] : [`--since=${startedAt}`];
const commits = git("log", ...range, "--no-merges", "--format=%h%x1f%s%x1f%b%x1e") ?? "";
const commitList = commits
  .split("\x1e")
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [sha, subject, body] = c.split("\x1f");
    return { sha, subject, body: (body ?? "").trim() };
  });
const dirty = (git("status", "--porcelain") ?? "").split("\n").filter(Boolean).length;

if (commitList.length === 0) process.exit(0); // nothing git can vouch for

// The assistant's last message is the session's own summary of what it did,
// which is often better than the commit subjects at saying what was left out.
function lastAssistantMessage(path) {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry.type !== "assistant") continue;
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
        : typeof content === "string" ? content : "";
      if (text.trim()) return text.trim().slice(0, MAX_MESSAGE);
    }
  } catch {
    /* no transcript, or not readable: the commits still stand */
  }
  return null;
}
const lastMessage = input.transcript_path ? lastAssistantMessage(String(input.transcript_path)) : null;

let log = [
  `Repository: ${repo} (branch ${branch})`,
  `Session: ${startedAt} → ${new Date().toISOString()}`,
  "",
  `Commits in this session (${commitList.length}):`,
  ...commitList.flatMap((c) => [`- ${c.sha} ${c.subject}`, ...(c.body ? c.body.split("\n").map((l) => `    ${l}`) : [])]),
  "",
  dirty ? `Uncommitted changes left in the working tree: ${dirty} file(s).` : "Working tree clean.",
  ...(lastMessage ? ["", "The assistant's last message of the session:", lastMessage] : []),
].join("\n");
if (log.length > MAX_LOG) log = `${log.slice(0, MAX_LOG)}\n\n[cut at ${MAX_LOG} characters]`;

// ── send it ─────────────────────────────────────────────────────────────────
// One JSON-RPC call to the hub's MCP endpoint, the same call Claude Code would
// make for the skill's tool. A long run answers with a run id, which is fine:
// the result is a set of proposals on /approvals, not something to wait for.

const toolName = `hub_skill_${skill.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}`;
try {
  const res = await fetch(`${hubUrl}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: { log, repo, branch } },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    warn(`hub answered ${res.status} — the work log for ${commitList.length} commit(s) was not sent.`);
    process.exit(0);
  }
  const text = await res.text();
  const refused = /"isError"\s*:\s*true/.test(text) || /Unknown tool|not allowed/i.test(text);
  warn(
    refused
      ? `the hub refused ${toolName}: ${text.replace(/\s+/g, " ").slice(0, 200)}`
      : `sent ${commitList.length} commit(s) on ${repo} to ${skill}; what it proposes appears on ${hubUrl}/approvals.`,
  );
} catch (err) {
  warn(`could not reach ${hubUrl} (${err?.message ?? err}) — the work log was not sent.`);
}
process.exit(0);
