import { listDocuments, listCollections, embedderStatus, listSources } from "@ai-hub/rag";
import { KnowledgeConsole } from "./KnowledgeConsole";
import { PageHeader } from "@/components/PageHeader";
import type { KnowledgeSnapshot, SourceRow } from "./types";

export const dynamic = "force-dynamic";

// The Knowledge / RAG management page (docs/knowledge-rag.md, Phase 1): see what
// the RAG knows, add or remove documents, and test what a query would retrieve —
// so the context an agent gets is inspectable instead of a black box.
export default async function KnowledgePage() {
  let snapshot: KnowledgeSnapshot = { documents: [], collections: [] };
  let sources: SourceRow[] = [];
  let embedder: { name: string; production: boolean } | null = null;
  let error: string | null = null;
  try {
    const [documents, collections] = await Promise.all([
      listDocuments(),
      listCollections(),
    ]);
    snapshot = { documents, collections };
    sources = listSources();
    embedder = embedderStatus();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load knowledge.";
  }

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Knowledge"
        title="Knowledge base"
        subtitle="The documents your Skills can retrieve as context. Add or remove sources, and test exactly what a query would pull."
      />

      {error ? (
        <div className="panel border-l-2 border-l-[var(--warning)] p-4 text-sm text-[var(--warning)]">
          Couldn&apos;t load knowledge: {error}
          <div className="mt-2 text-[var(--muted)]">
            Set <code>DATABASE_URL</code> and run{" "}
            <code>npm run migrate -w @ai-hub/db</code>.
          </div>
        </div>
      ) : (
        <KnowledgeConsole initial={snapshot} sources={sources} embedder={embedder} />
      )}
    </main>
  );
}
