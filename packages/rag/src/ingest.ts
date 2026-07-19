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
      insert into documents (source, title, metadata)
      values (${input.source ?? null}, ${input.title ?? ""},
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
  source: string | null;
  title: string;
  chunkCount: number;
  createdAt: string;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const sql = getSql();
  return sql<DocumentSummary[]>`
    select d.id, d.source, d.title,
           count(c.id)::int as "chunkCount",
           d.created_at      as "createdAt"
    from documents d
    left join document_chunks c on c.document_id = d.id
    group by d.id
    order by d.created_at desc
  `;
}
