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
import { MAX_UPLOAD_BYTES, type KnowledgeSnapshot, type RetrievedRow, type DocDetail } from "./types";

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

/**
 * A file someone chose on the Documents page: Word, PowerPoint, Excel, PDF,
 * a transcript or plain text, read to text by the same reader the Teams
 * server uses (@ai-hub/mcp/fileText) and ingested like a pasted document.
 * Nothing of the file is kept but its text. Everything that goes wrong is
 * said in words a person can act on: the wrong format, too big, scanned.
 */
export async function addFileAction(form: FormData): Promise<KnowledgeSnapshot | { error: string }> {
  if (!(await sessionCan("document:write"))) return { error: NOT_ALLOWED };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file first." };
  // Loaded here, not at the top: pdf.js is large, and only this action needs it.
  const { canRead, fileText, READABLE } = await import("@ai-hub/mcp/fileText");
  if (!canRead(file.name)) {
    return { error: `"${file.name}" is not a kind of file the hub can read. It reads ${READABLE}. Old .doc, .xls and .ppt files need saving in the current format first.` };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Split it, or paste the part that matters.` };
  }
  let text: string | null;
  try {
    text = await fileText(file.name, new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    return { error: `Could not read "${file.name}": ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!text?.trim()) {
    return {
      error: /\.pdf$/i.test(file.name)
        ? `"${file.name}" has no text in it — it is probably scanned pages, which are pictures. Use a PDF with selectable text, or paste the text.`
        : `"${file.name}" has no text in it.`,
    };
  }
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  try {
    await ingestDocument({
      title: str("title") || file.name.replace(/\.[^.]+$/, ""),
      source: str("source") || file.name,
      collection: str("collection") || undefined,
      sourceType: "upload",
      content: text,
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
