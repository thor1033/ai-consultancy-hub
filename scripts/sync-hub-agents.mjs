#!/usr/bin/env node
// Pulls the hub's agents placed "local" or "both" into this project's .claude/
// directory, as Claude Code sub-agents and skills. Run by the SessionStart hook
// in .claude/settings.json; safe to run by hand. See docs/local-agents.md.
//
//   HUB_URL    the hub's origin (default https://hub.teqneo.co)
//   HUB_TOKEN  a hub_sk_… credential issued from /admin, or an OAuth access
//              token. Optional where a proxy injects the hub's credential.
//
// Never fails the session: if the hub is unreachable it says so on stderr and
// leaves the last synced files in place. It only ever writes, and only ever
// deletes, files it wrote itself — `hub-` prefixed, and listed in the manifest.
//
// --user writes into ~/.claude instead of the project, so the agents follow
// you into every project. That is what scripts/setup-claude-code.mjs installs.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, rmdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const claudeDir = process.argv.includes("--user")
  ? join(homedir(), ".claude")
  : join(projectDir, ".claude");
const manifestPath = join(claudeDir, ".hub-sync.json");
const hubUrl = (process.env.HUB_URL || "https://hub.teqneo.co").replace(/\/+$/, "");
const token = process.env.HUB_TOKEN?.trim();
const fromHook = !process.stdin.isTTY && process.argv.includes("--hook");

// The only shapes the hub may name. Anything else in the response is ignored,
// so a compromised or buggy hub cannot write outside .claude/ or over a
// hand-made agent.
const ALLOWED = /^(agents\/hub-[a-z0-9][a-z0-9-]*\.md|skills\/hub-[a-z0-9][a-z0-9-]*\/SKILL\.md)$/;

function warn(message) {
  process.stderr.write(`[sync-hub-agents] ${message}\n`);
}

function readManifest() {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return Array.isArray(parsed.files) ? parsed.files.filter((f) => ALLOWED.test(f)) : [];
  } catch {
    return [];
  }
}

function done(context) {
  if (fromHook) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          // Skills written after discovery are invisible until a re-scan.
          reloadSkills: true,
          ...(context ? { additionalContext: context } : {}),
        },
      }),
    );
  } else if (context) {
    console.log(context);
  }
  process.exit(0);
}

let payload;
try {
  const res = await fetch(`${hubUrl}/api/agents/export`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body.trimStart().startsWith("{") ? ` ${body.slice(0, 200)}` : "";
    warn(`hub answered ${res.status} — keeping the last synced agents.${detail}`);
    done("");
  }
  payload = await res.json();
} catch (err) {
  warn(`could not reach ${hubUrl} (${err?.message ?? err}) — keeping the last synced agents.`);
  done("");
}

const files = (Array.isArray(payload?.files) ? payload.files : []).filter(
  (f) => f && typeof f.path === "string" && typeof f.content === "string" && ALLOWED.test(f.path),
);

const previous = new Set(readManifest());
const current = new Set(files.map((f) => f.path));

for (const f of files) {
  const target = join(claudeDir, f.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, f.content);
}

// An agent moved back to "hub", disabled or deleted: take its files away too,
// or Claude Code keeps offering a sub-agent whose endpoint now refuses it.
for (const stale of previous) {
  if (current.has(stale)) continue;
  const target = join(claudeDir, stale);
  if (existsSync(target)) rmSync(target);
  const dir = dirname(target);
  if (stale.startsWith("skills/") && existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

mkdirSync(claudeDir, { recursive: true });
writeFileSync(
  manifestPath,
  JSON.stringify({ hub: hubUrl, syncedAt: new Date().toISOString(), files: [...current] }, null, 2) + "\n",
);

const agents = Array.isArray(payload?.agents) ? payload.agents : [];
if (!agents.length) {
  done("");
}
const lines = agents.map((a) => `- ${a.subAgent} — the hub's "${a.name}" agent (${a.placement})`);
done(
  `Agents synced from the AI hub (${hubUrl}) are available as sub-agents:\n${lines.join("\n")}\n` +
    "Delegate to one when a task matches what it is for. Their memory, knowledge and tools come " +
    "from the hub and are checked there; their definitions are edited in the hub, not in .claude/.",
);
