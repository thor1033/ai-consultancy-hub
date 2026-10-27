#!/usr/bin/env node
// One-command Claude Code setup for the AI hub. See docs/claude-code-setup.md.
//
//   node scripts/setup-claude-code.mjs --token hub_sk_…
//
// or, without cloning the repo:
//
//   curl -fsSL https://raw.githubusercontent.com/thor1033/ai-consultancy-hub/master/scripts/setup-claude-code.mjs \
//     | node - --token hub_sk_…
//
// What it does, all at user level so it works in every project:
//
//   1. checks the token against the hub
//   2. stores HUB_TOKEN and HUB_URL in ~/.claude/settings.json (`env`), where
//      the sync hook and each synced sub-agent's MCP connection read them
//   3. installs the agent sync as a SessionStart hook in the same file, and
//      the work log (what a session built, sent to the Project Manager when
//      the session ends) as SessionStart + SessionEnd hooks
//   4. adds the hub's MCP server (`ai-hub`) at user scope
//   5. optionally (--with-pm-tool) adds the PM-tool's MCP server, which signs
//      in with your own account through WorkOS the first time it is used
//   6. runs the first sync
//
// Re-running it is safe: it replaces its own entries and leaves everything
// else in your settings untouched. A backup of settings.json is kept as
// settings.json.before-hub.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const RAW = "https://raw.githubusercontent.com/thor1033/ai-consultancy-hub/master/scripts";
const PM_TOOL_MCP = "https://pm.teqneo.co/api/mcp";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hubUrl = (flag("--hub-url") || process.env.HUB_URL || "https://hub.teqneo.co").replace(/\/+$/, "");
const withPmTool = args.includes("--with-pm-tool");

const claudeHome = join(homedir(), ".claude");
const settingsPath = join(claudeHome, "settings.json");
const hubHome = join(claudeHome, "hub");
const syncTarget = join(hubHome, "sync-hub-agents.mjs");
const workLogTarget = join(hubHome, "hub-work-log.mjs");

const say = (m) => console.log(m);
const fail = (m) => {
  console.error(`\n✗ ${m}`);
  process.exit(1);
};

// ── 1. the token ────────────────────────────────────────────────────────────
let token = flag("--token") || process.env.HUB_TOKEN;
if (!token && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  token = await rl.question("Hub credential (hub_sk_…, from the hub's /admin page): ");
  rl.close();
}
token = token?.trim();
if (!token) fail("No credential. Ask a hub admin to issue you one in /admin, then pass --token hub_sk_…");

say(`Checking the credential against ${hubUrl} …`);
let toolCount = 0;
try {
  const res = await fetch(`${hubUrl}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) fail("The hub does not recognise that credential (revoked, mistyped, or for another hub).");
  if (!res.ok) fail(`The hub answered ${res.status}.`);
  toolCount = (await res.json()).result?.tools?.length ?? 0;
} catch (err) {
  fail(`Could not reach ${hubUrl}: ${err?.message ?? err}`);
}
say(`  ✓ accepted — ${toolCount} hub tools available to you`);

// ── 2 & 3. settings.json: env + hook ────────────────────────────────────────
mkdirSync(hubHome, { recursive: true });
// Next to this file when run from a clone; downloaded when piped from curl.
let scriptsDir = null;
try {
  scriptsDir = dirname(fileURLToPath(import.meta.url));
} catch {
  /* piped from stdin: no file of our own */
}
for (const [name, target] of [
  ["sync-hub-agents.mjs", syncTarget],
  ["hub-work-log.mjs", workLogTarget],
]) {
  const localCopy = scriptsDir ? join(scriptsDir, name) : null;
  if (localCopy && existsSync(localCopy)) {
    copyFileSync(localCopy, target);
  } else {
    const res = await fetch(`${RAW}/${name}`);
    if (!res.ok) fail(`Could not download ${name} (${res.status}).`);
    writeFileSync(target, await res.text());
  }
}
say(`  ✓ sync and work-log scripts installed in ${hubHome}`);

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    fail(`${settingsPath} is not valid JSON — fix it first; nothing was changed.`);
  }
  copyFileSync(settingsPath, `${settingsPath}.before-hub`);
}
settings.env = { ...(settings.env ?? {}), HUB_TOKEN: token, HUB_URL: hubUrl };
// Our own entries are recognised by the script they run, so re-running
// replaces them and leaves every other hook alone.
const ours = (group) => (group.hooks ?? []).some((h) => /sync-hub-agents\.mjs|hub-work-log\.mjs/.test(String(h.command ?? "")));
const sessionStart = (settings.hooks?.SessionStart ?? []).filter((g) => !ours(g));
sessionStart.push({
  matcher: "startup|resume|clear",
  hooks: [
    { type: "command", command: `node "${syncTarget}" --hook --user`, timeout: 30 },
    { type: "command", command: `node "${workLogTarget}" --start`, timeout: 10 },
  ],
});
const sessionEnd = (settings.hooks?.SessionEnd ?? []).filter((g) => !ours(g));
sessionEnd.push({ hooks: [{ type: "command", command: `node "${workLogTarget}" --hook`, timeout: 30 }] });
settings.hooks = { ...(settings.hooks ?? {}), SessionStart: sessionStart, SessionEnd: sessionEnd };
mkdirSync(claudeHome, { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
say(`  ✓ HUB_TOKEN, HUB_URL, the sync hook and the work-log hooks saved in ${settingsPath}`);

// ── 4 & 5. MCP servers ──────────────────────────────────────────────────────
const hasClaude = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
const addServer = (name, extra) => {
  const cmd = ["mcp", "add", "--scope", "user", "--transport", "http", name, ...extra];
  if (!hasClaude) {
    say(`  • Claude Code CLI not found — run this once it is installed:\n      claude ${cmd.map((c) => (c.includes(" ") ? `"${c}"` : c)).join(" ")}`);
    return;
  }
  spawnSync("claude", ["mcp", "remove", "--scope", "user", name], { stdio: "ignore" });
  try {
    execFileSync("claude", cmd, { stdio: "ignore" });
    say(`  ✓ MCP server "${name}" added for every project`);
  } catch {
    say(`  • Could not add "${name}" automatically. Run: claude ${cmd.join(" ")}`);
  }
};
addServer("ai-hub", [`${hubUrl}/api/mcp`, "--header", `Authorization: Bearer ${token}`]);
if (withPmTool) addServer("pm-tool", [PM_TOOL_MCP]);

// ── 6. first sync ───────────────────────────────────────────────────────────
const sync = spawnSync(process.execPath, [syncTarget, "--user"], {
  env: { ...process.env, HUB_TOKEN: token, HUB_URL: hubUrl },
  encoding: "utf8",
});
say(sync.stdout?.trim() ? `\n${sync.stdout.trim()}` : "\nNo agents are set to run locally yet — they will appear as soon as an admin switches one to Local or Both.");
if (sync.stderr?.trim()) say(sync.stderr.trim());

say(`
Done. Start a new Claude Code session to pick everything up.
  • Hub agents set to Local or Both appear as hub-<name> sub-agents, in every project.
  • The hub's own tools (knowledge search, hub_agent_*, hub_skill_*) come from the "ai-hub" server.${
  withPmTool ? '\n  • The first PM-tool call opens a browser to sign in (or run /mcp and pick "pm-tool").' : ""
}
Your credential is stored in ${settingsPath}; keep that file private.`);
