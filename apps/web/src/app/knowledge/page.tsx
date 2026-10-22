import { listDocuments, listCollections, embedderStatus, listSources } from "@ai-hub/rag";
import { listAgentKnowledgeScopes, restrictedCollectionNames } from "@ai-hub/db";
import { defaultVisibility } from "@ai-hub/authz";
import { KnowledgeConsole } from "./KnowledgeConsole";
import { PageHeader } from "@/components/PageHeader";
import { sessionCan, sessionKnowledgeAccess } from "@/lib/sessionPrincipal";
import type { KnowledgeSnapshot, KnowledgeContext, SourceRow } from "./types";

export const dynamic = "force-dynamic";

// The Knowledge page: what the agents can look up. Every list here is narrowed
// to what the signed-in person may read — the same rule /api/mcp applies — so
// the page never becomes the way around a restricted collection.
export default async function KnowledgePage() {
  let snapshot: KnowledgeSnapshot = { documents: [], collections: [] };
  let context: KnowledgeContext = { restricted: [], scopes: [], defaultVisibility: "open" };
  let sources: SourceRow[] = [];
  let embedder: { name: string; production: boolean } | null = null;
  let canWrite = false;
  let error: string | null = null;
  try {
    const access = await sessionKnowledgeAccess();
    const [documents, collections, restricted, scopes, writer] = await Promise.all([
      listDocuments(access),
      listCollections(access),
      restrictedCollectionNames(),
      listAgentKnowledgeScopes(),
      sessionCan("document:write"),
    ]);
    snapshot = { documents, collections };
    // Only name what this person can already see.
    const visible = new Set(collections);
    context = {
      restricted: restricted.filter((c) => visible.has(c)),
      scopes: scopes.filter((s) => visible.has(s.collection)),
      defaultVisibility: defaultVisibility(),
    };
    sources = listSources();
    embedder = embedderStatus();
    canWrite = Boolean(writer);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load knowledge.";
  }

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      {error ? (
        <>
          <PageHeader eyebrow="Knowledge" title="Knowledge" />
          <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">
            Couldn&apos;t load knowledge: {error}
            <div className="mt-2 text-[var(--muted)]">
              Set <code>DATABASE_URL</code> and run <code>npm run migrate -w @ai-hub/db</code>.
            </div>
          </div>
        </>
      ) : (
        <KnowledgeConsole
          initial={snapshot}
          context={context}
          sources={sources}
          embedder={embedder}
          canWrite={canWrite}
        />
      )}
    </main>
  );
}
