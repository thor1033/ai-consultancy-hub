// The importer (docs/skill-import.md): a GitHub link to a SKILL.md or an
// agent file becomes an agent or a skill, with its source kept on the row.
//
//   node --experimental-transform-types --env-file=.env.local verify-import.mjs
//
// Needs DATABASE_URL and a migrated database. No network: a throwaway HTTP
// server stands in for raw.githubusercontent.com and serves a small
// repository — a SKILL.md in a folder, a sub-agent file, a LICENSE, a file
// too large, a file with no frontmatter — so every path through the fetcher
// is driven against content this script chose.
//
// What is proven: the parser reads both shapes and the odd cases (CRLF, a
// BOM, folded descriptions, quoted values, a list of tools, no frontmatter);
// a pasted address is refused unless it is GitHub over https; a folder reads
// its SKILL.md, a file reads itself, a missing file is said; the size limit
// holds; the license comes from the file or the repository's LICENSE and is
// never guessed; an agent and a skill are created with the source, hash and
// license on the row, the hub's rules appended when asked, and nothing the
// file asked for granted.
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

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

const { parseAgentFile, githubTarget, rawUrl, licenseFromText, skillTemplateFrom, HUB_RULES_ADDENDUM } = await import("../../packages/db/src/skillmd.ts");
const { fetchAgentFile, MAX_FILE_BYTES } = await import("./src/lib/importAgentFile.ts");
const db = await import("../../packages/db/src/index.ts");
const sql = db.getSql();

// ── 1. the parser ───────────────────────────────────────────────────────────
console.log("— the parser —");
const skillMd = `---\nname: brand-review\ndescription: >\n  Review a document against\n  the brand guidelines.\nlicense: Apache-2.0\n---\n\n# Brand review\n\nRead the document. Check the voice.\n`;
let p = parseAgentFile(skillMd);
check("a SKILL.md: name, folded description, license, body", p.name === "brand-review" && p.description === "Review a document against the brand guidelines." && p.license === "Apache-2.0" && p.body.startsWith("# Brand review") && !p.bare);
const agentMd = `﻿---\r\nname: legal-advisor\r\ndescription: "Reviews contracts"\r\ntools: Read, Grep, Bash\r\nmodel: sonnet\r\ncolor: blue\r\nteam: legal\r\n---\r\nYou are a legal advisor.\r\n`;
p = parseAgentFile(agentMd);
check("a sub-agent file with a BOM and CRLF: quoted description, tools, model, extra keys kept", p.name === "legal-advisor" && p.description === "Reviews contracts" && JSON.stringify(p.tools) === '["Read","Grep","Bash"]' && p.model === "sonnet" && p.extra.team === "legal" && !("color" in p.extra) && p.body === "You are a legal advisor.");
p = parseAgentFile("---\nname: x\ntools: [Edit, Write]\n---\nbody");
check("a bracketed tool list", JSON.stringify(p.tools) === '["Edit","Write"]');
p = parseAgentFile("# Deal Strategist\n\nYou qualify deals.");
check("a file with no frontmatter is bare and named by its heading", p.bare && p.name === "Deal Strategist" && p.body.startsWith("# Deal Strategist") && p.description === "");
check("a frontmatter line that is not key: value does not break the rest", parseAgentFile("---\nname: a\n- stray\ndescription: b\n---\nc").description === "b");
check("licenses are read from a LICENSE's first lines, and an unknown one is null", licenseFromText("MIT License\n\nCopyright") === "MIT" && licenseFromText("                                 Apache License\n                           Version 2.0, January 2004") === "Apache-2.0" && licenseFromText("Do whatever") === null && licenseFromText(null) === null);
check("a skill's template is its text, then the request", /\{\{request\}\}$/.test(skillTemplateFrom("Do the thing.")) && skillTemplateFrom("Do the thing.").startsWith("Do the thing."));

console.log("\n— the address —");
const t = (u) => githubTarget(u);
check("a folder link reads as a tree path", JSON.stringify(t("https://github.com/anthropics/skills/tree/main/skills/brand")) === JSON.stringify({ repo: "anthropics/skills", ref: "main", path: "skills/brand", file: false }));
check("a file link reads as a blob path", JSON.stringify(t("https://github.com/o/r/blob/v1.2/agents/legal.md")) === JSON.stringify({ repo: "o/r", ref: "v1.2", path: "agents/legal.md", file: true }));
check("a raw link reads as a file", JSON.stringify(t("https://raw.githubusercontent.com/o/r/main/SKILL.md")) === JSON.stringify({ repo: "o/r", ref: "main", path: "SKILL.md", file: true }));
check("a repository link reads as its root at HEAD", JSON.stringify(t("https://github.com/o/r")) === JSON.stringify({ repo: "o/r", ref: "HEAD", path: "", file: false }));
check("another host is refused", /Only GitHub/.test(t("https://gitlab.com/o/r/-/blob/main/x.md").error ?? "") && /Only GitHub/.test(t("https://github.com.evil.example/o/r").error ?? ""));
check("http:// is refused", /https/.test(t("http://github.com/o/r").error ?? ""));
check("not a URL is refused", /not a URL/.test(t("anthropics/skills").error ?? ""));
check("an unknown page kind is refused", /Paste a link/.test(t("https://github.com/o/r/issues/4").error ?? ""));
check("the raw URL encodes path segments", rawUrl({ repo: "o/r", ref: "main", path: "a b/SKILL.md", file: true }) === "https://raw.githubusercontent.com/o/r/main/a%20b/SKILL.md");

// ── 2. the fetcher, against a stand-in GitHub ───────────────────────────────
console.log("\n— the fetcher —");
const files = {
  "/acme/skills/main/skills/brand/SKILL.md": skillMd,
  "/acme/skills/main/LICENSE": "Apache License\nVersion 2.0, January 2004\n",
  "/acme/agents/HEAD/agents/legal.md": agentMd,
  "/acme/agents/HEAD/LICENSE": "MIT License\n\nCopyright (c) 2026\n",
  "/acme/nolicense/HEAD/SKILL.md": "---\nname: bare-skill\ndescription: d\n---\nDo it.",
  "/acme/big/HEAD/SKILL.md": `---\nname: big\ndescription: d\n---\n${"x".repeat(MAX_FILE_BYTES + 10)}`,
  "/acme/empty/HEAD/SKILL.md": "---\nname: e\ndescription: d\n---\n\n",
};
const served = [];
const http = createServer((req, res) => {
  served.push(req.url);
  const body = files[req.url];
  if (body === undefined) {
    res.writeHead(404);
    res.end("404");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const rawBase = `http://127.0.0.1:${http.address().port}`;
const get = (u) => fetchAgentFile(u, { rawBase });

const folder = await get("https://github.com/acme/skills/tree/main/skills/brand");
check("a folder link reads its SKILL.md", !("error" in folder) && folder.parsed.name === "brand-review" && folder.source.path === "skills/brand/SKILL.md", folder.error);
check("the license comes from the file's own frontmatter, and the repository's LICENSE is not read", folder.source?.license === "Apache-2.0" && !served.includes("/acme/skills/main/LICENSE"));
check("the source records the link, the raw file, repo, ref, path and the file's hash", folder.source?.url === "https://github.com/acme/skills/tree/main/skills/brand" && folder.source.repo === "acme/skills" && folder.source.ref === "main" && folder.source.sha256 === createHash("sha256").update(skillMd).digest("hex") && /^\d{4}-/.test(folder.source.importedAt));
const file = await get("https://github.com/acme/agents/blob/HEAD/agents/legal.md");
check("a file link reads that file, and the license comes from the repository's LICENSE", !("error" in file) && file.parsed.name === "legal-advisor" && file.source.license === "MIT", file.error);
const none = await get("https://github.com/acme/nolicense");
check("a repository link reads its root SKILL.md; no LICENSE anywhere is recorded as not found, never guessed", !("error" in none) && none.parsed.name === "bare-skill" && none.source.license === null, none.error);
const missing = await get("https://github.com/acme/skills/tree/main/skills/nothing");
check("a folder with no SKILL.md is said, with what to paste instead", /No SKILL\.md in skills\/nothing/.test(missing.error ?? ""), missing.error);
const missingFile = await get("https://github.com/acme/skills/blob/main/skills/gone.md");
check("a missing file is said", /no file at skills\/gone\.md on main of acme\/skills/.test(missingFile.error ?? ""), missingFile.error);
const big = await get("https://github.com/acme/big");
check("a file over the limit is refused by size", /256 KB/.test(big.error ?? ""), big.error);
const empty = await get("https://github.com/acme/empty");
check("a file with no instructions is refused", /no instructions/.test(empty.error ?? ""), empty.error);
const notMd = await get("https://github.com/acme/skills/blob/main/scripts/run.py");
check("a file that is not Markdown is refused before it is fetched", /Markdown/.test(notMd.error ?? "") && !served.includes("/acme/skills/main/scripts/run.py"));
const other = await get("https://gitlab.com/acme/skills");
check("another host is refused before anything is reached", /Only GitHub/.test(other.error ?? ""));

// ── 3. the rows ─────────────────────────────────────────────────────────────
console.log("\n— the rows —");
const stamp = Date.now();
const made = [];
try {
  const host = await db.createAgent({ slug: `verify-import-host-${stamp}`, name: "Host", instructions: "host" });
  made.push(host.id);
  // The action re-fetches, so the same path is driven here with the fetcher
  // and the store, as the action does it.
  const agentFile = await get("https://github.com/acme/agents/blob/HEAD/agents/legal.md");
  const agent = await db.createAgent({
    slug: `verify-import-legal-${stamp}`,
    name: agentFile.parsed.name,
    description: agentFile.parsed.description,
    instructions: `${agentFile.parsed.body}${HUB_RULES_ADDENDUM}`,
    model: "claude-sonnet-4-6",
    mcpServers: [],
    source: agentFile.source,
  });
  made.push(agent.id);
  const back = await db.getAgent(agent.slug);
  check("an imported agent keeps its source, with repo, link, license and hash", back.source?.kind === "github" && back.source.repo === "acme/agents" && back.source.license === "MIT" && back.source.sha256 === agentFile.source.sha256);
  check("its brief is the file's, with the hub's rules appended when asked", back.instructions.startsWith("You are a legal advisor.") && /## On this hub/.test(back.instructions) && /held for a person's approval/.test(back.instructions));
  check("nothing the file asked for is granted: no tool servers, memory on, the model alias mapped", back.mcpServers.length === 0 && back.keepsMemory === true && back.model === "claude-sonnet-4-6");
  const skillFile = await get("https://github.com/acme/skills/tree/main/skills/brand");
  const skill = await db.createSkill({
    agentId: host.id,
    slug: `verify-import-brand-${stamp}`,
    name: skillFile.parsed.name,
    description: skillFile.parsed.description,
    promptTemplate: skillTemplateFrom(skillFile.parsed.body),
    parameters: [{ name: "request", description: "what", required: true }],
    source: skillFile.source,
  });
  const sk = await db.getSkill(skill.slug);
  check("an imported skill keeps its source and takes the request as its one parameter", sk.source?.repo === "acme/skills" && sk.source.license === "Apache-2.0" && sk.parameters.length === 1 && sk.parameters[0].name === "request" && /\{\{request\}\}$/.test(sk.promptTemplate));
  const { fillTemplate } = await import("./src/lib/skillPrompt.ts");
  const filled = fillTemplate(sk.promptTemplate, sk.parameters, { request: "Check the deck." });
  check("and fills as a skill does: the instructions, then the request", !("error" in filled) && filled.prompt.startsWith("# Brand review") && /The request:\nCheck the deck\.$/.test(filled.prompt));
  const listed = (await db.listSkills(host.id)).find((s) => s.id === skill.id);
  check("the skills list carries the source for the page", listed?.source?.url === "https://github.com/acme/skills/tree/main/skills/brand");
  const roster = (await db.agentRoster()).find((a) => a.id === agent.id);
  check("a hand-made agent and the roster are unaffected: source is null where nothing was imported", (await db.getAgent(host.id)).source === null && Boolean(roster));
} finally {
  for (const id of made) await db.deleteAgent(id).catch(() => {});
  await sql.end({ timeout: 5 });
  http.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exit(1);
console.log("Not proven here: GitHub itself — run the importer once on a real link; and the worth of what is imported, which is the person's reading of the preview.");
