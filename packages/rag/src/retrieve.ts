import { getSql } from "@ai-hub/db";
import { getEmbedder } from "./embeddings";

function toVector(arr: number[]): string {
  return `[${arr.join(",")}]`;
}

export interface RetrievedChunk {
  content: string;
  title: string | null;
  documentId: string;
  chunkIndex: number;
  score: number; // cosine similarity in [0, 1]
}

// Embeds the query and returns the top-k most similar chunks (pgvector cosine).
export async function retrieveChunks(query: string, k = 5): Promise<RetrievedChunk[]> {
  const sql = getSql();
  const [vec] = await getEmbedder().embed([query]);
  const qv = toVector(vec);

  return sql<RetrievedChunk[]>`
    select dc.content,
           d.title,
           dc.document_id as "documentId",
           dc.chunk_index as "chunkIndex",
           1 - (dc.embedding <=> ${qv}::vector) as score
    from document_chunks dc
    join documents d on d.id = dc.document_id
    order by dc.embedding <=> ${qv}::vector
    limit ${k}
  `;
}

// Formats retrieved chunks into a context block for the agent.
export function chunksToContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.title ? `${c.title}: ` : ""}${c.content}`)
    .join("\n\n");
}
