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
import type { KnowledgeSnapshot, RetrievedRow, DocDetail } from "./types";

// Server actions for the knowledge management page. Like the workbench, these run
// server-trusted; binding them to a logged-in principal (so the PolicyEngine gates
// UI writes too) lands with WorkOS SSO in Phase 2.

async function snapshot(): Promise<KnowledgeSnapshot> {
  const [documents, collections] = await Promise.all([
    listDocuments(),
    listCollections(),
  ]);
  return { documents, collections };
}

export async function addDocumentAction(input: {
  title?: string;
  source?: string;
  collection?: string;
  content: string;
}): Promise<KnowledgeSnapshot | { error: string }> {
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
    const doc = await getDocument(id);
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
    const chunks = await retrieveChunks(query, k);
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
