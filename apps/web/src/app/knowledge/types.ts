// Client-facing shapes for the knowledge console, kept out of the "use server"
// module (which may only export async functions).

export interface DocRow {
  id: string;
  sourceType: string;
  source: string | null;
  collection: string | null;
  title: string;
  chunkCount: number;
  preview: string | null;
  createdAt: string;
}

export interface DocDetail {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
  chunks: { chunkIndex: number; content: string }[];
}

export interface KnowledgeSnapshot {
  documents: DocRow[];
  collections: string[];
}

export interface RetrievedRow {
  title: string | null;
  documentId: string;
  chunkIndex: number;
  score: number; // cosine similarity in [0,1]
  preview: string; // first slice of the chunk, for inspection
}

export interface KnowledgeContext {
  /** Visible collections an admin has marked restricted. */
  restricted: string[];
  /** Agents whose retrieval is scoped to a visible collection. */
  scopes: { name: string; slug: string; collection: string }[];
  /** How a collection nobody has classified is treated. */
  defaultVisibility: "open" | "restricted";
}

export interface SourceRow {
  type: string;
  label: string;
  configured: boolean;
  /** Where a sync files its documents when no collection is named. */
  defaultCollection?: string;
  /** Synced on the clock this often (minutes); unset means only by hand. */
  autoSyncMinutes?: number;
  /** The last sync on the clock — what it did, or why it failed. */
  lastSync?: { at: string | null; running: boolean; ok: boolean | null; summary: string; error: string | null };
}

/**
 * The largest file the Documents page takes (addFileAction). Below
 * serverActions.bodySizeLimit in next.config.ts, which leaves room for the
 * form's other fields; here so the page can say so before uploading.
 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
