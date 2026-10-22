import { authorize } from "@ai-hub/authz";
import { contextSnapshot, type ContextSnapshot } from "@ai-hub/db";
import { PageHeader } from "@/components/PageHeader";
import { sessionCan } from "@/lib/sessionPrincipal";
import { ContextView } from "./ContextView";

export const dynamic = "force-dynamic";

// The Context page: what the workspace's agents know right now, drawn as one
// brain. Read live on every request — there is no cache between this page and
// the agents' memory, so what it shows is what the next run starts from.
export default async function ContextPage() {
  const principal = await sessionCan("agent:run");
  if (!principal) {
    return (
      <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
        <PageHeader eyebrow="Context" title="Context" />
        <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">
          Your role does not include the agents, so their context is not shown.
        </div>
      </main>
    );
  }

  let snapshot: ContextSnapshot | null = null;
  let error: string | null = null;
  try {
    snapshot = await contextSnapshot();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load the workspace's context.";
  }

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      {error || !snapshot ? (
        <>
          <PageHeader eyebrow="Context" title="Context" />
          <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">{error}</div>
        </>
      ) : (
        <ContextView snapshot={snapshot} canManage={await authorize(principal, "agent:manage")} />
      )}
    </main>
  );
}
