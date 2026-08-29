import { notFound } from "next/navigation";
import Link from "next/link";
import { getAgent, listMemories } from "@ai-hub/db";
import { listCollections } from "@ai-hub/rag";
import { PageHeader } from "@/components/PageHeader";
import { knownServers } from "@/lib/runSession";
import { AgentConsole } from "./AgentConsole";

export const dynamic = "force-dynamic";

// One agent: talk to it, see what it remembers, and change what it is.
//
// Memory is shown beside the conversation on purpose. An agent that quietly
// accumulates beliefs about a client is a liability; being able to read and
// delete any one of them is what makes it something you'd point at real work.
export default async function AgentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const agent = await getAgent(slug);
  if (!agent) notFound();

  // An empty knowledge list is not an error here — it just means nothing has
  // been ingested yet, and the agent still runs fine without RAG.
  const [memories, collections] = await Promise.all([
    listMemories(agent.id),
    listCollections().catch(() => [] as string[]),
  ]);

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← Agents
      </Link>
      <div className="mt-3">
        <PageHeader
          eyebrow={agent.slug}
          title={agent.name}
          subtitle={agent.description || "No description."}
        />
      </div>
      <AgentConsole
        agent={agent}
        memories={memories}
        servers={knownServers()}
        collections={collections}
      />
    </main>
  );
}
