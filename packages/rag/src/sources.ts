import { builtinServerConfig, connectMcpServers, remoteServerConfig, type ConnectedMcp } from "@ai-hub/mcp";
import { ingestDocument, deleteDocumentsBySource } from "./ingest";

// Pluggable knowledge sources (docs/knowledge-rag.md, Phase 3). A source fetches
// documents from some external system and yields them in a normalized shape; the
// registry maps a document's source_type to the connector that produced it. New
// connectors (SharePoint, Office files) register here without touching the core —
// and are added demand-driven, with each source's permission model designed then.

export interface SourceDocument {
  externalId: string; // stable id within the source, e.g. "confluence:12345"
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSource {
  readonly type: string; // matches documents.source_type
  readonly label: string;
  readonly configured: boolean; // whether the required env/credentials are present
  /**
   * Where this source's documents are filed when the sync names no
   * collection. A source that is one repository or one space knows which
   * drawer it belongs in; a person syncing it from /knowledge should not have
   * to remember.
   */
  readonly defaultCollection?: string;
  fetch(): Promise<SourceDocument[]>;
}

export interface SourceInfo {
  type: string;
  label: string;
  configured: boolean;
  defaultCollection?: string;
}

// Factories so `configured` is re-evaluated (env may change) on every read.
const factories = new Map<string, () => KnowledgeSource>();

// A family is several sources declared by one env var — one per repository,
// say — whose number and names are not known until the env is read. Evaluated
// on every read for the same reason the factories are: a cached parse makes a
// config change in dev look ignored.
const families: (() => KnowledgeSource[])[] = [];

export function registerSource(type: string, factory: () => KnowledgeSource): void {
  factories.set(type, factory);
}

export function registerSourceFamily(factory: () => KnowledgeSource[]): void {
  families.push(factory);
}

function allSources(): KnowledgeSource[] {
  return [...[...factories.values()].map((f) => f()), ...families.flatMap((f) => f())];
}

export function getSource(type: string): KnowledgeSource | undefined {
  const direct = factories.get(type)?.();
  if (direct) return direct;
  return families.flatMap((f) => f()).find((s) => s.type === type);
}

export function listSources(): SourceInfo[] {
  return allSources().map((s) => ({
    type: s.type,
    label: s.label,
    configured: s.configured,
    ...(s.defaultCollection ? { defaultCollection: s.defaultCollection } : {}),
  }));
}

export interface SyncResult {
  type: string;
  fetched: number;
  documents: number;
  chunks: number;
}

// Pulls every document from a source and upserts it (replace-by-source, so a
// re-sync doesn't duplicate). Optionally files everything under a collection.
export async function syncSource(
  type: string,
  opts: { collection?: string } = {},
): Promise<SyncResult> {
  const source = getSource(type);
  if (!source) throw new Error(`Unknown source: ${type}`);
  if (!source.configured) throw new Error(`${source.label} is not configured.`);

  const docs = await source.fetch();
  const collection = opts.collection ?? source.defaultCollection;
  let chunks = 0;
  for (const d of docs) {
    await deleteDocumentsBySource(type, d.externalId);
    const r = await ingestDocument({
      title: d.title,
      content: d.content,
      source: d.externalId,
      sourceType: type,
      collection,
      metadata: d.metadata,
    });
    chunks += r.chunks;
  }
  return { type, fetched: docs.length, documents: docs.length, chunks };
}

// Very small storage-format/HTML → text: strip tags and collapse whitespace.
// Good enough for indexing; a richer converter is a later refinement.
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Confluence connector. Real fetch against the Cloud v2 API, but gated on
// credentials — unconfigured it simply reports configured:false so the UI shows
// it as available-but-not-connected. This is the seam a client engagement wires up.
export function confluenceSource(): KnowledgeSource {
  const base = process.env.CONFLUENCE_BASE_URL; // e.g. https://acme.atlassian.net
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  const configured = Boolean(base && email && token);

  return {
    type: "confluence",
    label: "Confluence",
    configured,
    async fetch(): Promise<SourceDocument[]> {
      if (!configured) {
        throw new Error(
          "Confluence is not configured. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.",
        );
      }
      const auth = Buffer.from(`${email}:${token}`).toString("base64");
      const res = await fetch(
        `${base}/wiki/api/v2/pages?body-format=storage&limit=50`,
        { headers: { authorization: `Basic ${auth}`, accept: "application/json" } },
      );
      if (!res.ok) {
        throw new Error(`Confluence fetch failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as {
        results?: {
          id: string;
          title?: string;
          spaceId?: string;
          version?: { number?: number };
          body?: { storage?: { value?: string } };
          _links?: { webui?: string };
        }[];
      };
      return (json.results ?? []).map((p) => ({
        externalId: `confluence:${p.id}`,
        title: p.title ?? "Untitled",
        content: htmlToText(p.body?.storage?.value ?? ""),
        metadata: {
          spaceId: p.spaceId,
          version: p.version?.number,
          url: p._links?.webui ? `${base}/wiki${p._links.webui}` : undefined,
        },
      }));
    },
  };
}

registerSource("confluence", confluenceSource);

// ── PM-tool (Atlas) ─────────────────────────────────────────────────────────
//
// The hub's first connected client system. It already exposes an authenticated
// MCP endpoint (see packages/mcp/src/remote.ts), so this connector reuses that
// connection rather than adding a second endpoint and a second credential —
// declare the server once in HUB_REMOTE_MCP_SERVERS and both the agent's live
// tool calls and this sync are configured.
//
// What gets indexed is the whole point of the split: only the *documents* — the
// slow-moving prose a person authored (business case, scope, glossary, notes).
// The board is deliberately excluded. Task status changes hourly, and an
// embedded copy would answer confidently with yesterday's state; live state is
// what the MCP tools are for. If you ever find yourself adding "tasks" below,
// the answer is a tool call, not a vector.

const PM_DOCUMENT_SECTIONS: { key: string; label: string }[] = [
  { key: "businessCase", label: "Business case" },
  { key: "scope", label: "Scope" },
  { key: "assessment", label: "Assessment" },
  { key: "commPlan", label: "Communication plan" },
  { key: "changePlan", label: "Change plan" },
  { key: "glossary", label: "Glossary" },
  { key: "kpis", label: "KPIs" },
  { key: "financials", label: "Financials" },
  { key: "startup", label: "Startup" },
];

// forecast/settings are configuration, orgChart is a diagram blob — none of the
// three is prose anyone would ask a question about, so they are left out.

// Internal ids carry no meaning to a reader and no signal to an embedding; they
// only dilute the vector.
const PM_IGNORED_KEYS = new Set(["id", "orgId", "projectId"]);

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * jsonb → readable lines.
 *
 * The sections share no single shape: some are objects of strings, some arrays
 * of records, and PM-tool adds fields over time. A generic walk means a new
 * field starts being indexed the day it appears instead of silently going
 * missing. Empty values are dropped, so an untouched section renders to nothing
 * at all rather than a page of blank labels — which would otherwise be embedded
 * and match everything weakly.
 */
function renderJsonLines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      const lines = renderJsonLines(item);
      if (lines.length === 0) continue;
      out.push(`- ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`));
    }
    return out;
  }

  if (typeof value === "object") {
    const out: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (PM_IGNORED_KEYS.has(key)) continue;
      const lines = renderJsonLines(child);
      if (lines.length === 0) continue;
      if (lines.length === 1) out.push(`${humanizeKey(key)}: ${lines[0]}`);
      else out.push(`${humanizeKey(key)}:`, ...lines.map((l) => `  ${l}`));
    }
    return out;
  }

  return [];
}

const renderSection = (value: unknown): string => renderJsonLines(value).join("\n").trim();

/** MCP tools answer with a JSON text block; `execute` flattens that to a string. */
async function pmCallJson(
  mcp: ConnectedMcp,
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const text = await mcp.execute(tool, input);
  if (text.startsWith("Tool error:") || text.startsWith("Unknown tool:")) {
    throw new Error(`PM-tool ${tool} failed — ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`PM-tool ${tool} did not return JSON: ${text.slice(0, 200)}`);
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

export function pmToolSource(): KnowledgeSource {
  // The name this server is declared under in HUB_REMOTE_MCP_SERVERS. Overridable
  // because that key is the deployer's to choose; "pm-tool" is the convention.
  const serverName = process.env.PM_TOOL_MCP_SERVER || "pm-tool";
  const config = remoteServerConfig(serverName);
  // Same definition of "configured" the MCP registry uses, so the two views of
  // this server can never disagree about whether it is wired up.
  const configured = Boolean(config && Object.keys(config.headers ?? {}).length > 0);

  return {
    type: "pm-tool",
    label: "PM-tool (Atlas)",
    configured,
    async fetch(): Promise<SourceDocument[]> {
      if (!config) {
        throw new Error(
          `No remote MCP server "${serverName}" is declared. Add it to HUB_REMOTE_MCP_SERVERS.`,
        );
      }
      if (!configured) {
        throw new Error(
          `The "${serverName}" MCP server has no credential — set the env var named by its tokenEnv.`,
        );
      }

      // Deep-link back to the project so a retrieved chunk can be traced to the
      // page a person edits.
      const baseUrl = config.url.replace(/\/api\/mcp\/?$/, "");

      const mcp = await connectMcpServers([config]);
      try {
        const projects = await pmCallJson(mcp, "pm_list_projects", {});
        if (!Array.isArray(projects)) {
          throw new Error("PM-tool pm_list_projects did not return a list.");
        }

        const docs: SourceDocument[] = [];
        for (const entry of projects) {
          const projectId = asString(asRecord(entry).id);
          if (!projectId) continue;

          // Only the notes collection: the board is not indexed, and asking for
          // it would pull the whole working set across the wire for nothing.
          const detail = asRecord(
            await pmCallJson(mcp, "pm_get_project", {
              projectId,
              sections: ["notes"],
            }),
          );
          const project = asRecord(detail.project);
          const projectName = asString(project.name) || "Untitled project";
          const url = `${baseUrl}/projects/${projectId}`;

          for (const { key, label } of PM_DOCUMENT_SECTIONS) {
            const content = renderSection(project[key]);
            if (!content) continue; // untouched section — nothing to index
            docs.push({
              externalId: `pm-tool:${projectId}:${key}`,
              title: `${projectName} — ${label}`,
              // The title is repeated in the body because chunks are retrieved
              // without it, and "Glossary" alone does not say whose glossary.
              content: `${projectName} — ${label}\n\n${content}`,
              metadata: { projectId, projectName, section: key, url },
            });
          }

          for (const raw of Array.isArray(detail.notes) ? detail.notes : []) {
            const note = asRecord(raw);
            const noteId = asString(note.id);
            const body = asString(note.body).trim();
            if (!noteId || !body) continue;
            const noteTitle = asString(note.title) || "Untitled note";
            const date = asString(note.date);
            docs.push({
              externalId: `pm-tool:${projectId}:note:${noteId}`,
              title: `${projectName} — Note: ${noteTitle}`,
              content: `${projectName} — Note: ${noteTitle}${date ? ` (${date})` : ""}\n\n${body}`,
              metadata: {
                projectId,
                projectName,
                section: "notes",
                noteId,
                date: date || undefined,
                url,
              },
            });
          }
        }
        return docs;
      } finally {
        // Always close: a leaked HTTP client keeps the sync process alive.
        await mcp.close();
      }
    },
  };
}

registerSource("pm-tool", pmToolSource);

// ── Teams meeting notes ─────────────────────────────────────────────────────
//
// The notes an agent saved with teams_notes_save, indexed so any agent scoped
// to the collection can answer "when did we decide X?" across every meeting.
// SharePoint is the record and this is its index: the files are read back
// through the read-only `teams` server — the same Graph code and the same
// Sites.Selected fence the agents use — rather than a second Graph client.

/** Where filed meeting notes go. Agents read them by being scoped to it. */
export const TEAMS_NOTES_COLLECTION = "meetings";

/** teams_file_read answers with a few header lines, a blank line, then the text. */
function fileBody(answer: string): string {
  const at = answer.indexOf("\n\n");
  return at < 0 ? "" : answer.slice(at + 2);
}

export function teamsNotesSource(): KnowledgeSource {
  const folder = process.env.M365_TEAMS_NOTES_FOLDER?.trim() ?? "";
  const configured = Boolean(
    folder &&
      process.env.M365_TEAMS_SITE_URL &&
      process.env.M365_TENANT_ID &&
      process.env.M365_CLIENT_ID &&
      process.env.M365_CLIENT_SECRET,
  );

  return {
    type: "teams-notes",
    label: "Teams meeting notes",
    configured,
    async fetch(): Promise<SourceDocument[]> {
      if (!configured) {
        throw new Error(
          "Teams meeting notes are not configured. Set M365_TEAMS_SITE_URL and M365_TEAMS_NOTES_FOLDER (docs/teams.md).",
        );
      }
      const mcp = await connectMcpServers([builtinServerConfig("teams")!]);
      try {
        const listing = await mcp.execute("teams_files_list", { path: folder });
        // No folder yet means no notes yet: the first save creates it.
        if (listing.startsWith("Nothing in") || (listing.startsWith("Tool error:") && /itemNotFound|404/.test(listing))) {
          return [];
        }
        if (listing.startsWith("Tool error:")) throw new Error(`Could not list ${folder}: ${listing}`);
        const items = (JSON.parse(listing) as { items?: { itemId: string; name: string; kind: string; path?: string; webUrl?: string; modified?: string }[] }).items ?? [];

        const docs: SourceDocument[] = [];
        for (const item of items.filter((i) => i.kind === "file" && /\.md$/i.test(i.name))) {
          // Read every page: a note is short, but a cut-off one would be indexed
          // as if it were the whole meeting.
          let content = "";
          let offset = 0;
          for (let page = 0; page < 20; page++) {
            const answer = await mcp.execute("teams_file_read", { itemId: item.itemId, ...(offset ? { offset } : {}) });
            if (answer.startsWith("Tool error:")) throw new Error(`Could not read ${item.name}: ${answer}`);
            content += fileBody(answer);
            const next = answer.match(/call again with offset=(\d+)/);
            if (!next) break;
            offset = Number(next[1]);
          }
          if (!content.trim()) continue;
          docs.push({
            externalId: `teams-notes:${item.itemId}`,
            title: item.name.replace(/\.md$/i, ""),
            content,
            metadata: { path: item.path, url: item.webUrl, modified: item.modified },
          });
        }
        return docs;
      } finally {
        await mcp.close();
      }
    },
  };
}

registerSource("teams-notes", teamsNotesSource);

// ── GitHub repository docs ──────────────────────────────────────────────────
//
// The design record of a product we build lives in its repository: docs/,
// README, CLAUDE.md. An agent that owns a product has to know that record, and
// the only honest way is to index it from the repository itself — a copy
// pasted into /knowledge is wrong by the next merge.
//
// Configured per repository, so each one files into its own collection and a
// product owner is scoped to exactly its product:
//
//   HUB_GITHUB_SOURCES='{
//     "hub":   { "repo": "thor1033/ai-consultancy-hub", "ref": "master",
//                "paths": ["docs", "README.md", "CLAUDE.md"], "collection": "hub-product" },
//     "atlas": { "repo": "thor1033/pm-tool", "paths": ["README.md", "AGENTS.md"], "collection": "atlas-product" }
//   }'
//   GITHUB_TOKEN=…   a fine-grained token, Contents: read, on those repositories only
//
// Each entry is a source of type `github:<key>`. Fails closed like every other
// env-declared registry: malformed JSON ⇒ no sources at all, and a missing token
// ⇒ declared but not connected, never an unauthenticated read that happens to
// work on a public repository and stops the day it goes private.
//
// What is indexed is a snapshot, and it says so: every document carries the
// commit it was read at. The agent reads the current file through the GitHub
// MCP server when exactness matters; retrieval is for finding, not for quoting
// the latest line.

interface GithubSourceEntry {
  repo: string;
  ref?: string;
  paths?: string[];
  collection?: string;
}

/** Fine-grained personal access token: Contents (read) on the listed repositories. */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

const GITHUB_API = () => (process.env.GITHUB_API_BASE_URL?.replace(/\/+$/, "") || "https://api.github.com");

/** Only prose. Code and configuration are read live, never embedded. */
const GITHUB_DOC_EXTENSIONS = /\.(md|mdx|markdown|txt)$/i;

/** A file this large is a log or a dump, not a document anyone wrote. */
const GITHUB_MAX_FILE_BYTES = 256 * 1024;

/** Enough for a docs/ folder; a repository with more is a wiki, and a sync cap keeps the embedder bill bounded. */
const GITHUB_MAX_FILES = 300;

function loadGithubEntries(): Record<string, GithubSourceEntry> {
  const raw = process.env.HUB_GITHUB_SOURCES;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[rag] HUB_GITHUB_SOURCES is not valid JSON — no GitHub sources configured.");
    return {};
  }
  const out: Record<string, GithubSourceEntry> = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const e = asRecord(value);
    // owner/name, nothing else: the value is spliced into an API path.
    if (!/^[a-z0-9_.-]+$/i.test(key) || !/^[\w.-]+\/[\w.-]+$/.test(asString(e.repo))) continue;
    out[key] = {
      repo: asString(e.repo),
      ref: asString(e.ref) || undefined,
      paths: Array.isArray(e.paths) ? e.paths.filter((p): p is string => typeof p === "string" && p.trim() !== "") : undefined,
      collection: asString(e.collection) || undefined,
    };
  }
  return out;
}

/** Is `file` one of the configured paths, or inside one of them? */
function underPaths(file: string, paths: string[]): boolean {
  return paths.some((p) => {
    const clean = p.replace(/^\/+|\/+$/g, "");
    return file === clean || file.startsWith(`${clean}/`);
  });
}

/** The document's title: its first heading, else the file name. */
function markdownTitle(path: string, content: string): string {
  const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading || path.split("/").pop()!.replace(GITHUB_DOC_EXTENSIONS, "");
}

async function githubJson(token: string, path: string, accept = "application/vnd.github+json"): Promise<Response> {
  const res = await fetch(`${GITHUB_API()}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept, "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(
      `GitHub ${res.status} on ${path}: ${text}` +
        (res.status === 404 ? " (a private repository the token cannot see answers 404, not 403)" : ""),
    );
  }
  return res;
}

export function githubDocsSource(key: string, entry: GithubSourceEntry): KnowledgeSource {
  const token = process.env[GITHUB_TOKEN_ENV] || "";
  const ref = entry.ref || "HEAD";
  const paths = entry.paths?.length ? entry.paths : ["docs", "README.md"];

  return {
    type: `github:${key}`,
    label: `GitHub — ${entry.repo}`,
    configured: Boolean(token),
    defaultCollection: entry.collection,
    async fetch(): Promise<SourceDocument[]> {
      if (!token) {
        throw new Error(`GitHub is not connected: set ${GITHUB_TOKEN_ENV} (a fine-grained token with Contents: read on ${entry.repo}).`);
      }
      // Pin the whole read to one commit, so a push in the middle of a sync
      // cannot produce an index that is half one version and half another.
      const head = (await (await githubJson(token, `/repos/${entry.repo}/commits/${encodeURIComponent(ref)}`)).json()) as {
        sha?: string;
        commit?: { committer?: { date?: string } };
      };
      const sha = asString(head.sha);
      if (!sha) throw new Error(`GitHub returned no commit for ${entry.repo}@${ref}.`);

      const tree = (await (await githubJson(token, `/repos/${entry.repo}/git/trees/${sha}?recursive=1`)).json()) as {
        truncated?: boolean;
        tree?: { path?: string; type?: string; size?: number }[];
      };
      // A truncated tree would index some of the docs and present them as all
      // of them, which is the one failure a reader cannot see.
      if (tree.truncated) throw new Error(`${entry.repo} is too large to list in one call; narrow "paths" or index a smaller repository.`);

      const files = (tree.tree ?? []).filter(
        (t) => t.type === "blob" && typeof t.path === "string" && GITHUB_DOC_EXTENSIONS.test(t.path) && underPaths(t.path, paths),
      );
      if (files.length > GITHUB_MAX_FILES) {
        throw new Error(`${entry.repo} has ${files.length} documents under ${paths.join(", ")}; the cap is ${GITHUB_MAX_FILES}. Narrow "paths".`);
      }

      const docs: SourceDocument[] = [];
      for (const f of files) {
        const path = f.path!;
        if ((f.size ?? 0) > GITHUB_MAX_FILE_BYTES) continue;
        const content = (
          await (await githubJson(token, `/repos/${entry.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "application/vnd.github.raw+json")).text()
        ).trim();
        if (!content) continue;
        const title = markdownTitle(path, content);
        docs.push({
          externalId: `github:${entry.repo}:${path}`,
          // The path is in the body because chunks are retrieved without the
          // title, and "Setup" alone does not say whose setup.
          title: `${title} (${path})`,
          content: `${title} — ${entry.repo}/${path}\n\n${content}`,
          metadata: {
            repo: entry.repo,
            path,
            ref,
            sha,
            committedAt: head.commit?.committer?.date,
            url: `https://github.com/${entry.repo}/blob/${sha}/${path}`,
          },
        });
      }
      return docs;
    },
  };
}

export function githubDocsSources(): KnowledgeSource[] {
  return Object.entries(loadGithubEntries()).map(([key, entry]) => githubDocsSource(key, entry));
}

registerSourceFamily(githubDocsSources);
