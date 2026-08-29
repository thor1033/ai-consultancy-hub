import { listAgents } from "@ai-hub/db";
import { PageHeader } from "@/components/PageHeader";
import { knownServers } from "@/lib/runSession";
import { AgentList } from "./AgentList";

export const dynamic = "force-dynamic";

// The agents console: every standing agent in this hub.
//
// A Skill is a captured workflow you run; an agent is someone you keep. That is
// why this page leads with what each one remembers — an agent with no memories
// has never actually been used, and the count says so at a glance.
export default async function AgentsPage() {
  let agents: Awaited<ReturnType<typeof listAgents>> = [];
  let error: string | null = null;
  try {
    agents = await listAgents();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load agents.";
  }

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Agents"
        title="Standing agents"
        subtitle="Named workers with their own instructions, tools and memory. Unlike a Skill, an agent persists between conversations and remembers what it learns."
      />
      {error ? (
        <div className="panel border-l-2 border-l-[var(--warning)] p-4 text-sm text-[var(--warning)]">
          {error}
        </div>
      ) : (
        <AgentList agents={agents} servers={knownServers()} />
      )}
    </main>
  );
}
