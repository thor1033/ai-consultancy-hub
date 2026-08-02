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
