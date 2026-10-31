# Importing agents and skills from GitHub

Status: **built**. `/agents/import`.

## The idea

The open ecosystem has two file shapes worth reading, and they are the same
form: a Markdown file with YAML frontmatter and instructions beneath it.

| Shape | Where | What the hub makes of it |
|---|---|---|
| **SKILL.md** — the Agent Skills standard (agentskills.io), a folder with a `SKILL.md` and optional scripts and references | `anthropics/skills`, the "awesome" lists | a **skill** on an agent (its text as the task's standing instructions, the caller's request appended) — or an agent of its own |
| **A sub-agent file** — `name`, `description`, optional `tools`, `model`, `color`; the body is a system prompt | `msitarzewski/agency-agents`, `VoltAgent/awesome-claude-code-subagents`, `wshobson/agents` | an **agent**: the body is its brief |

The importer reads one file from GitHub, shows every line of it, and creates
the row only when a person says so. Nothing is imported in bulk: a brief is a
system prompt a person is about to hand an agent, and it was written by a
stranger for another product.

## What a person sees

1. Paste a link: a folder (`…/tree/…`, reads its `SKILL.md`), a file
   (`…/blob/…`), a raw file, or a repository (reads the root `SKILL.md`).
2. The preview: name, description, which shape it is, the repository and
   ref, the **license** (from the file's frontmatter, else the repository's
   `LICENSE`, else *not found*), the length, what the file asks for (tools
   and model, which are another product's and are **never granted**), any
   frontmatter the hub does not use, and the instructions in full.
3. What it becomes: a new agent (name, slug, function, owner), or a skill on
   an agent you pick. One checkbox, on by default, appends the hub's
   standing rules to the instructions: writes wait for approval, memory
   first, say what you cannot do. The file was written for a product with
   none of those.
4. Create. The file is read again at that moment, and the row keeps its
   source: the link, the raw file, repo, ref, path, license, when, and the
   file's SHA-256, so a later look can tell whether upstream changed.

An imported agent gets no tool servers and keeps memory; both are chosen on
its page, from what this hub has. An imported skill takes one parameter,
`request`, and its template is the file's text followed by the request.

## Fences

- **Only GitHub, only https.** The hub fetches from its server; any other
  host is refused before anything is reached.
- **Markdown only, 256 KB at most, ten seconds.** A file that is not `.md`
  is refused before it is fetched.
- **Admin to create; anyone who may run agents may preview.**
- **Nothing granted.** The file's `tools` are shown and ignored. Its `model`
  alias (opus, sonnet, haiku) maps to the hub's model id; anything else is
  the default.
- **The license is recorded, never guessed.** *Not found* and
  *unrecognised* are shown in warning colour on the preview. The document
  skills in `anthropics/skills` are source-available, not open source;
  check before relying on one.

## Where to look

| Repository | What is in it | License |
|---|---|---|
| `anthropics/skills` | Anthropic's own: a template, the spec, example skills for communication, branding, MCP server generation; the document skills (docx, pptx, xlsx, pdf) | Apache-2.0; document skills source-available |
| `msitarzewski/agency-agents` | ~230 personas across 18 departments, with mission, rules, deliverables, workflow, metrics | MIT |
| `VoltAgent/awesome-claude-code-subagents` | ~170 sub-agents; Business & Product and Research & Analysis groups hold legal, compliance, market and competitive research | MIT |
| `wshobson/agents` | ~190 engineering sub-agents and orchestrators | MIT |

Licenses vary per skill inside the "awesome" lists; the preview reads the
one that applies to the file imported.

## How it is built

```
packages/db/src/skillmd.ts            parseAgentFile · githubTarget · rawUrl · licenseFromText (pure)
apps/web/src/lib/importAgentFile.ts   fetchAgentFile: the fences, the LICENSE fallback, the source record
apps/web/src/app/agents/import        the page, the form, previewImportAction / importAction
agents.source · agent_skills.source   where a row came from (jsonb, null for everything hand-made)
```

## Verify

```bash
npm run verify:import -w web          # needs DATABASE_URL + a migrated DB; no network
```

A throwaway HTTP server stands in for `raw.githubusercontent.com` with a
small repository: both shapes, a LICENSE, a file too large, one with no
frontmatter. 34 checks: the parser on the odd cases (BOM, CRLF, folded and
quoted values, bracketed lists, no frontmatter); every refused address; a
folder reads its SKILL.md and a file itself; the license from the file,
from LICENSE, or not found; the size limit; and the rows created with
source, hash, license, the rules appended, nothing granted, the skill
filling as a skill does.

**Not proven:** GitHub itself (run the importer once on a real link), and
whether what is imported is any good — that is the person's reading of the
preview, which is why the preview shows every line.

## What this deliberately does not do

- **Import in bulk, or sync with upstream.** One file, read by a person.
  The hash on the row is for a person to compare, not for the hub to pull.
- **Run a skill's scripts.** A SKILL.md folder may carry `scripts/`; the hub
  reads the instructions only. An agent on the hub has the hub's tools.
- **Export.** Writing a hub agent's skills out as SKILL.md folders is the
  natural next step, and a separate one.
