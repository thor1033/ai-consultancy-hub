import { getSql } from "@ai-hub/db";
import type { KnowledgeAccess } from "@ai-hub/authz";
import { getEmbedder } from "./embeddings";
import { accessPredicate } from "./access";

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

export interface RetrieveOptions {
  // Curation (docs/knowledge-rag.md): scope retrieval to one collection or a
  // set of them, so an agent draws from its curated drawers instead of the
  // whole index. Omit for global. An empty set matches nothing — scoped to no
  // drawer is not the same as unscoped, and a caller that meant "everything"
  // omits the option.
  //
  // This is *curation*, not permission, and the two are enforced separately: a
  // caller naming a collection they may not read gets nothing, because `access`
  // is ANDed with it rather than overridden by it.
  collection?: string | readonly string[];
}

/**
 * Embeds the query and returns the top-k most similar chunks (pgvector cosine),
 * narrowed to what `access` permits.
 *
 * `access` is a required argument. It could have defaulted to "everything" and
 * saved a few call sites some typing, and then the one read path that forgot to
 * pass it would be the leak — silently, at runtime, in production. Required
 * means a forgotten filter does not compile.
 *
 * The filter is applied in SQL, before the limit, so a restricted document
 * cannot consume one of the k slots and leave the caller with fewer results
 * than they may actually see.
 */
export async function retrieveChunks(
  query: string,
  access: KnowledgeAccess,
  k = 5,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const sql = getSql();
  const [vec] = await getEmbedder().embed([query]);
  const qv = toVector(vec);

  const permitted = accessPredicate(access);
  const names =
    opts.collection === undefined ? null : typeof opts.collection === "string" ? [opts.collection] : [...opts.collection];
  const curated =
    names === null ? sql`` : names.length === 0 ? sql`and false` : sql`and d.collection = any(${names}::text[])`;

  return sql<RetrievedChunk[]>`
    select dc.content,
           d.title,
           dc.document_id as "documentId",
           dc.chunk_index as "chunkIndex",
           1 - (dc.embedding <=> ${qv}::vector) as score
    from document_chunks dc
    join documents d on d.id = dc.document_id
    where ${permitted}
    ${curated}
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
