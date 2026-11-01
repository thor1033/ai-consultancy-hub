import Link from "next/link";
import { DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CEILING } from "@ai-hub/agent";
import { agentOrgLabels, listAgents } from "@ai-hub/db";
import { listCollections } from "@ai-hub/rag";
import { sessionCan, sessionKnowledgeAccess } from "@/lib/sessionPrincipal";
import { viewContext } from "@/lib/viewServer";
import { AgentForm } from "../AgentForm";
import { toolCatalog } from "../catalog";

export const dynamic = "force-dynamic";

// Hiring an agent. The form is shown to everyone who can open the hub, but only
// agent:manage can save it — saveAgentAction checks again, so the notice below
// is a courtesy, not the control.
export default async function NewAgentPage() {
  const [canManage, tools, collections, admin, orgLabels, agents, ctx] = await Promise.all([
    sessionCan("agent:manage"),
    toolCatalog(),
    sessionKnowledgeAccess()
      .then((access) => listCollections(access))
      .catch(() => [] as string[]),
    sessionCan("admin:manage"),
    agentOrgLabels().catch(() => ({ functions: [], owners: [] })),
    listAgents().catch(() => []),
    viewContext(),
  ]);
  const expert = ctx.view === "expert";

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← Agents
      </Link>
      <header className="mt-3">
        <div className="eyebrow">Agents / New</div>
        <h1 className="mt-3 text-3xl md:text-4xl">Hire an agent.</h1>
        {expert ? (
          <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
            Give it a name, a brief and the tools it may use. It starts remembering from its first conversation, and
            every connected client can call it the moment it is saved. Hiring several that work together?{" "}
            <Link href="/agents/patterns" className="text-[var(--text)] underline underline-offset-2">
              Start from a pattern
            </Link>
            . Found a brief or a SKILL.md on GitHub?{" "}
            <Link href="/agents/import" className="text-[var(--text)] underline underline-offset-2">
              Import it
            </Link>
            .
          </p>
        ) : (
          <>
            <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
              Fill in what it is called and what it should do, in plain words. It remembers what it learns from its first conversation.
            </p>
            {/* The quickest start for most people is a ready-made team; say so before the blank form. */}
            <Link href="/agents/patterns" className="panel panel-hover mt-4 flex max-w-2xl items-center justify-between gap-4 p-4">
              <span>
                <span className="block font-bold">Not sure where to start? Use a ready-made team</span>
                <span className="block text-sm text-[var(--muted)]">
                  A few agents already set up to work together — you only give them names and say what they are for.
                </span>
              </span>
              <span aria-hidden className="text-[var(--muted)]">→</span>
            </Link>
          </>
        )}
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
            knowledge: "none",
            knowledgeCollections: [],
            maxIterations: "",
            servers: [],
            enabled: true,
            placement: "hub",
            functionName: "",
            owner: "",
            mailboxes: {},
            writesAllowed: [],
            keepsMemory: true,
            asks: [],
          }}
          agents={agents.map((a) => ({ slug: a.slug, name: a.name, description: a.description }))}
          functions={orgLabels.functions}
          owners={orgLabels.owners}
          tools={tools}
          collections={collections}
          defaultMaxIterations={DEFAULT_MAX_ITERATIONS}
          maxIterationsCeiling={MAX_ITERATIONS_CEILING}
          canSetPlacement={Boolean(admin)}
          canAllowWrites={Boolean(admin)}
          localFiles={[]}
        />
      </div>
    </main>
  );
}
