// Client-facing shapes for the knowledge console, kept out of the "use server"
// module (which may only export async functions).

export interface DocRow {
  id: string;
  sourceType: string;
  source: string | null;
  collection: string | null;
  title: string;
  chunkCount: number;
  createdAt: string;
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

export interface SourceRow {
  type: string;
  label: string;
  configured: boolean;
}
