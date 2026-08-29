import { connectMcpServers, remoteServerConfig, type ConnectedMcp } from "@ai-hub/mcp";
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
  fetch(): Promise<SourceDocument[]>;
}

export interface SourceInfo {
  type: string;
  label: string;
  configured: boolean;
}

// Factories so `configured` is re-evaluated (env may change) on every read.
const factories = new Map<string, () => KnowledgeSource>();

export function registerSource(type: string, factory: () => KnowledgeSource): void {
  factories.set(type, factory);
}

export function getSource(type: string): KnowledgeSource | undefined {
  return factories.get(type)?.();
}

export function listSources(): SourceInfo[] {
  return [...factories.values()].map((f) => {
    const s = f();
    return { type: s.type, label: s.label, configured: s.configured };
  });
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
  let chunks = 0;
  for (const d of docs) {
    await deleteDocumentsBySource(type, d.externalId);
    const r = await ingestDocument({
      title: d.title,
      content: d.content,
      source: d.externalId,
      sourceType: type,
      collection: opts.collection,
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
