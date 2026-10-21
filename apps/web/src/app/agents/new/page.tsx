import Link from "next/link";
import { DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CEILING } from "@ai-hub/agent";
import { listCollections } from "@ai-hub/rag";
import { sessionCan, sessionKnowledgeAccess } from "@/lib/sessionPrincipal";
import { AgentForm } from "../AgentForm";
import { toolCatalog } from "../catalog";

export const dynamic = "force-dynamic";

// Hiring an agent. The form is shown to everyone who can open the hub, but only
// agent:manage can save it — saveAgentAction checks again, so the notice below
// is a courtesy, not the control.
export default async function NewAgentPage() {
  const [canManage, tools, collections] = await Promise.all([
    sessionCan("agent:manage"),
    toolCatalog(),
    sessionKnowledgeAccess()
      .then((access) => listCollections(access))
      .catch(() => [] as string[]),
  ]);

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← Agents
      </Link>
      <header className="mt-3">
        <div className="eyebrow">Agents / New</div>
        <h1 className="mt-3 text-3xl md:text-4xl">Hire an agent.</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          Give it a name, a brief and the tools it may use. It starts remembering from its first conversation, and
          every connected client can call it the moment it is saved.
        </p>
      </header>

      {!canManage && (
        <div className="panel notice-warning mt-6 p-4 text-sm text-[var(--warning)]">
          Only an admin can create agents. You can fill this in, but saving will be refused.
        </div>
      )}

      <div className="mt-6">
        <AgentForm
          initial={{
            id: null,
            slug: "",
            name: "",
            description: "",
            instructions: "",
            model: "",
            knowledgeCollection: "",
            maxIterations: "",
            servers: [],
            enabled: true,
          }}
          tools={tools}
          collections={collections}
          defaultMaxIterations={DEFAULT_MAX_ITERATIONS}
          maxIterationsCeiling={MAX_ITERATIONS_CEILING}
        />
      </div>
    </main>
  );
}
