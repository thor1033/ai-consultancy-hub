import Link from "next/link";
import { listDocuments, listCollections, embedderStatus } from "@ai-hub/rag";
import { KnowledgeConsole } from "./KnowledgeConsole";
import type { KnowledgeSnapshot } from "./types";

export const dynamic = "force-dynamic";

// The Knowledge / RAG management page (docs/knowledge-rag.md, Phase 1): see what
// the RAG knows, add or remove documents, and test what a query would retrieve —
// so the context an agent gets is inspectable instead of a black box.
export default async function KnowledgePage() {
  let snapshot: KnowledgeSnapshot = { documents: [], collections: [] };
  let embedder: { name: string; production: boolean } | null = null;
  let error: string | null = null;
  try {
    const [documents, collections] = await Promise.all([
      listDocuments(),
      listCollections(),
    ]);
    snapshot = { documents, collections };
    embedder = embedderStatus();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load knowledge.";
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Skills
      </Link>

      <header className="mt-6 mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge base</h1>
        <p className="mt-1 text-neutral-400">
          The documents your Skills can retrieve as context. Add or remove sources,
          and test exactly what a query would pull.
        </p>
      </header>

      {error ? (
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-300">
          Couldn&apos;t load knowledge: {error}
          <div className="mt-2 text-amber-400/80">
            Set <code>DATABASE_URL</code> and run{" "}
            <code>npm run migrate -w @ai-hub/db</code>.
          </div>
        </div>
      ) : (
        <KnowledgeConsole initial={snapshot} embedder={embedder} />
      )}
    </main>
  );
}
