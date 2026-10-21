"use server";

import {
  ingestDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  listCollections,
  retrieveChunks,
  syncSource,
} from "@ai-hub/rag";
import { sessionKnowledgeAccess, sessionCan } from "@/lib/sessionPrincipal";
import type { KnowledgeSnapshot, RetrievedRow, DocDetail } from "./types";

const NOT_ALLOWED = "You do not have permission to change the knowledge base.";

// Server actions for the knowledge management page.
//
// Every read narrows by the signed-in user's knowledge access, the same rule
// /api/mcp applies. Before increment 02 this console was server-trusted and
// unfiltered, which would have made it the way around the filter the moment
// retrieval started respecting the asker.

async function snapshot(): Promise<KnowledgeSnapshot> {
  const access = await sessionKnowledgeAccess();
  const [documents, collections] = await Promise.all([
    listDocuments(access),
    listCollections(access),
  ]);
  return { documents, collections };
}

export async function addDocumentAction(input: {
  title?: string;
  source?: string;
  collection?: string;
  content: string;
}): Promise<KnowledgeSnapshot | { error: string }> {
  if (!(await sessionCan("document:write"))) return { error: NOT_ALLOWED };
  if (!input.content.trim()) return { error: "Paste some content to ingest." };
  try {
    await ingestDocument({
      title: input.title?.trim() || undefined,
      source: input.source?.trim() || undefined,
      collection: input.collection?.trim() || undefined,
      sourceType: "manual",
      content: input.content,
    });
    return await snapshot();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Ingest failed." };
  }
}

// Lazily loads a document's full chunked content + metadata for the expandable
// row, so the list stays light and content is only fetched when inspected.
export async function getDocumentAction(
  id: string,
): Promise<DocDetail | { error: string }> {
  try {
    const doc = await getDocument(id, await sessionKnowledgeAccess());
    if (!doc) return { error: "Document not found." };
    return {
      id: doc.id,
      title: doc.title,
      metadata: doc.metadata,
      chunks: doc.chunks,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to load document." };
  }
}

export async function deleteDocumentAction(
  id: string,
): Promise<KnowledgeSnapshot | { error: string }> {
  if (!(await sessionCan("document:write"))) return { error: NOT_ALLOWED };
  try {
    const ok = await deleteDocument(id);
    if (!ok) return { error: "Document not found." };
    return await snapshot();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Delete failed." };
  }
}

export async function syncSourceAction(
  type: string,
  collection?: string,
): Promise<{ synced: number; chunks: number; snapshot: KnowledgeSnapshot } | { error: string }> {
  if (!(await sessionCan("document:write"))) return { error: NOT_ALLOWED };
  try {
    const result = await syncSource(type, { collection: collection?.trim() || undefined });
    return { synced: result.documents, chunks: result.chunks, snapshot: await snapshot() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Sync failed." };
  }
}

export async function testRetrievalAction(
  query: string,
  k = 5,
): Promise<{ chunks: RetrievedRow[] } | { error: string }> {
  if (!query.trim()) return { error: "Enter a query to test retrieval." };
  try {
    const chunks = await retrieveChunks(query, await sessionKnowledgeAccess(), k);
    return {
      chunks: chunks.map((c) => ({
        title: c.title,
        documentId: c.documentId,
        chunkIndex: c.chunkIndex,
        score: c.score,
        preview: c.content.slice(0, 240),
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Retrieval failed." };
  }
}
