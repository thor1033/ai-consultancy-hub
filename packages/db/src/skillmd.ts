/*
 * Reading an agent file from the open ecosystem (docs/skill-import.md).
 *
 * Two shapes share one form — a Markdown file with YAML frontmatter and the
 * instructions beneath it:
 *
 *   SKILL.md (the Agent Skills standard, agentskills.io): name, description,
 *     optional license; the body is what an agent follows when the skill is
 *     active. Lives in a folder that may hold scripts and references.
 *   a sub-agent file (Claude Code and the collections written for it): name,
 *     description, optional tools, model, color; the body is a system prompt.
 *
 * The hub maps a sub-agent file to an AGENT (the body is a brief) and a
 * SKILL.md to either a SKILL on an agent (the body as the task's standing
 * instructions, with the request appended) or an agent of its own. The
 * person chooses on the preview; this file only parses, and parsing trusts
 * nothing: the file comes from a public repository, so what is in it is data
 * until a person has read the preview and said yes.
 *
 * Pure, so the web app's fetcher and the verify script share it.
 */

export interface ParsedAgentFile {
  name: string;
  description: string;
  license: string | null;
  /** The instructions beneath the frontmatter, trimmed. */
  body: string;
  /** Tools a sub-agent file asks for (Claude Code's own, not the hub's); shown, never applied. */
  tools: string[];
  /** A model alias (opus, sonnet, haiku, inherit) if the file names one. */
  model: string | null;
  /** Frontmatter keys the hub does not use, kept for the preview. */
  extra: Record<string, string>;
  /** True when the file had no frontmatter at all. */
  bare: boolean;
}

/** Where an agent or skill came from, kept on its row. */
export interface ImportSource {
  kind: "github";
  /** The URL the person pasted. */
  url: string;
  /** The file actually read. */
  rawUrl: string;
  repo: string;
  ref: string;
  path: string;
  license: string | null;
  importedAt: string;
  /** SHA-256 of the file read, so a later re-import can tell "changed upstream". */
  sha256: string;
}

const MAX_FRONTMATTER_LINES = 200;

/** `name: value` lines only — the two shapes above use nothing deeper, and a nested document is not a brief. */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split("\n").slice(0, MAX_FRONTMATTER_LINES);
  let current: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) {
      current = m[1];
      let value = m[2].trim();
      if (value === "|" || value === ">" || value === "|-" || value === ">-") value = "";
      else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      out[current] = value;
    } else if (current && /^\s+\S/.test(line)) {
      // A continuation (a folded or literal block, or a wrapped description).
      out[current] = `${out[current]}${out[current] ? " " : ""}${line.trim()}`;
    }
  }
  return out;
}

/** "Read, Edit, Bash" or "[Read, Edit]" or a YAML list already folded to "- Read - Edit". */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(/,|\s+-\s+|^-\s+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function parseAgentFile(text: string): ParsedAgentFile {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const fm = m ? parseFrontmatter(m[1]) : {};
  const body = (m ? src.slice(m[0].length) : src).trim();
  const known = new Set(["name", "description", "license", "tools", "model", "color", "allowed-tools", "metadata"]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) if (!known.has(k) && v) extra[k] = v;
  // A bare file names itself by its first heading, if it has one.
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  return {
    name: (fm.name ?? "").trim() || heading,
    description: (fm.description ?? "").trim(),
    license: (fm.license ?? "").trim() || null,
    body,
    tools: parseList(fm.tools ?? fm["allowed-tools"]),
    model: (fm.model ?? "").trim().toLowerCase() || null,
    extra,
    bare: !m,
  };
}

/** The license a repository's LICENSE file names, from its first lines. */
export function licenseFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const head = text.slice(0, 600);
  if (/MIT License/i.test(head)) return "MIT";
  if (/Apache License,?\s*Version 2\.0/i.test(head)) return "Apache-2.0";
  if (/BSD 3-Clause|Redistribution and use in source and binary forms/i.test(head)) return "BSD-3-Clause";
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 3/i.test(head)) return "GPL-3.0";
  if (/GNU AFFERO/i.test(head)) return "AGPL-3.0";
  if (/Mozilla Public License,?\s*(v\.?|Version)\s*2/i.test(head)) return "MPL-2.0";
  if (/Creative Commons/i.test(head)) return "CC";
  if (/source-available|All rights reserved/i.test(head)) return "source-available";
  return null;
}

export interface GithubTarget {
  repo: string;
  ref: string;
  /** Path of the file to read, or of the folder when `file` is false. */
  path: string;
  /** Whether `path` names a file (blob/raw) rather than a folder (tree/root). */
  file: boolean;
}

/**
 * What a pasted GitHub URL points at. Only github.com and
 * raw.githubusercontent.com: a pasted address is fetched by the hub, from the
 * server, so anything else is refused rather than reached.
 */
export function githubTarget(input: string): GithubTarget | { error: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: "That is not a URL." };
  }
  if (url.protocol !== "https:") return { error: "Only https:// GitHub URLs can be imported." };
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "raw.githubusercontent.com") {
    if (parts.length < 4) return { error: "A raw GitHub URL needs owner, repository, ref and a file path." };
    const [owner, repo, ref, ...rest] = parts;
    return { repo: `${owner}/${repo}`, ref, path: rest.join("/"), file: true };
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return { error: "Only GitHub URLs can be imported (github.com or raw.githubusercontent.com)." };
  if (parts.length < 2) return { error: "A GitHub URL needs at least an owner and a repository." };
  const [owner, repo, kind, ref, ...rest] = parts;
  if (!kind) return { repo: `${owner}/${repo}`, ref: "HEAD", path: "", file: false };
  if ((kind === "tree" || kind === "blob") && ref) return { repo: `${owner}/${repo}`, ref, path: rest.join("/"), file: kind === "blob" };
  return { error: "Paste a link to a folder (…/tree/…), a file (…/blob/…), a raw file, or a repository." };
}

export function rawUrl(t: GithubTarget, path = t.path, base = "https://raw.githubusercontent.com"): string {
  return `${base}/${t.repo}/${t.ref}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The hub's standing rules, appended to an imported brief when the person asks. */
export const HUB_RULES_ADDENDUM = `

## On this hub

- Every write you make through a tool is held for a person's approval on the
  Approvals page before it happens; say what you proposed and carry on as if it
  has not happened yet. Never retry a held call.
- Start with memory_list when you have memory, and record what you learn with
  memory_write: one fact per key, nothing you can look up again.
- When a task needs a tool or an access you do not have, say so plainly and
  name it; do not work around it or present a partial answer as complete.`;

/** The template a SKILL.md becomes when it is added as a skill: its instructions, then the request. */
export function skillTemplateFrom(body: string): string {
  return `${body}\n\n---\n\nThe request:\n{{request}}`;
}

export const SKILL_REQUEST_PARAMETER = { name: "request", description: "What you want done with this skill, in plain words.", required: true };
