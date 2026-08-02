import { getSql } from "@ai-hub/db";
import { getEmbedder } from "./embeddings";
import { chunkText } from "./chunk";

// pgvector accepts a text literal like "[0.1,0.2,...]" cast to ::vector.
function toVector(arr: number[]): string {
  return `[${arr.join(",")}]`;
}

export interface IngestInput {
  title?: string;
  source?: string;
  sourceType?: string; // the connector that produced this doc; defaults to "manual"
  collection?: string; // curation label used to scope retrieval
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  documentId: string;
  chunks: number;
  embedder: string;
}

// Ingests one document: chunk → embed → store chunks with their vectors.
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const sql = getSql();
  const embedder = getEmbedder();

  const chunks = chunkText(input.content);
  if (chunks.length === 0) throw new Error("Document has no content to ingest.");

  const vectors = await embedder.embed(chunks);

  const documentId = await sql.begin(async (tx) => {
    const [doc] = await tx<{ id: string }[]>`
      insert into documents (source_type, source, collection, title, metadata)
      values (${input.sourceType ?? "manual"}, ${input.source ?? null},
              ${input.collection?.trim() || null}, ${input.title ?? ""},
              ${tx.json((input.metadata ?? {}) as never)})
      returning id
    `;
    for (let i = 0; i < chunks.length; i++) {
      await tx`
        insert into document_chunks (document_id, chunk_index, content, embedding)
        values (${doc.id}, ${i}, ${chunks[i]}, ${toVector(vectors[i])}::vector)
      `;
    }
    return doc.id;
  });

  return { documentId, chunks: chunks.length, embedder: embedder.name };
}

export interface DocumentSummary {
  id: string;
  sourceType: string;
  source: string | null;
  collection: string | null;
  title: string;
  chunkCount: number;
  preview: string | null; // first slice of the document, for an at-a-glance sense
  createdAt: string;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const sql = getSql();
  return sql<DocumentSummary[]>`
    select d.id, d.source_type as "sourceType", d.source, d.collection, d.title,
           count(c.id)::int as "chunkCount",
           left(first_chunk.content, 220) as "preview",
           d.created_at      as "createdAt"
    from documents d
    left join document_chunks c on c.document_id = d.id
    left join lateral (
      select content from document_chunks
      where document_id = d.id order by chunk_index limit 1
    ) first_chunk on true
    group by d.id, first_chunk.content
    order by d.created_at desc
  `;
}

export interface DocumentDetail extends DocumentSummary {
  metadata: Record<string, unknown>;
  chunks: { chunkIndex: number; content: string }[];
}

export async function getDocument(id: string): Promise<DocumentDetail | null> {
  const sql = getSql();
  const [doc] = await sql<Omit<DocumentDetail, "chunks" | "chunkCount">[]>`
    select id, source_type as "sourceType", source, collection, title, metadata,
           created_at as "createdAt"
    from documents where id = ${id}
  `;
  if (!doc) return null;

  const chunks = await sql<{ chunkIndex: number; content: string }[]>`
    select chunk_index as "chunkIndex", content
    from document_chunks where document_id = ${id}
    order by chunk_index
  `;
  return { ...doc, chunkCount: chunks.length, chunks };
}

// Deletes a document and its chunks (ON DELETE CASCADE handles the chunks).
export async function deleteDocument(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from documents where id = ${id}`;
  return rows.count > 0;
}

// Upsert primitive for connectors: drop any docs previously synced from this exact
// (source_type, source) so a re-sync replaces rather than duplicates. Returns the
// number removed.
export async function deleteDocumentsBySource(
  sourceType: string,
  source: string,
): Promise<number> {
  const sql = getSql();
  const rows = await sql`
    delete from documents where source_type = ${sourceType} and source = ${source}
  `;
  return rows.count;
}

// The distinct curation labels in use, for the management UI's collection picker.
export async function listCollections(): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<{ collection: string }[]>`
    select distinct collection from documents
    where collection is not null and collection <> ''
    order by collection
  `;
  return rows.map((r) => r.collection);
}
