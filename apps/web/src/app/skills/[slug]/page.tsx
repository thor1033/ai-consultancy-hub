import Link from "next/link";
import { notFound } from "next/navigation";
import { getSkill } from "@ai-hub/db";
import { listCollections } from "@ai-hub/rag";
import { RunPanel } from "./RunPanel";
import { KnowledgeScope } from "./KnowledgeScope";

export const dynamic = "force-dynamic";

export default async function SkillPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let skill: Awaited<ReturnType<typeof getSkill>> = null;
  let collections: string[] = [];
  let error: string | null = null;
  try {
    [skill, collections] = await Promise.all([getSkill(slug), listCollections()]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load skill.";
  }

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
          ← Skills
        </Link>
        <div className="mt-6 rounded-lg border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-300">
          Couldn&apos;t load this skill: {error}
        </div>
      </main>
    );
  }

  if (!skill) notFound();

  const latest = skill.versions[0];

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Skills
      </Link>

      <div className="mt-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{skill.name}</h1>
          <p className="mt-1 text-neutral-400">
            {skill.description || "No description."}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
          v{skill.latestVersion ?? "—"}
        </span>
      </div>

      {latest && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {latest.model && (
            <Badge>{latest.model}</Badge>
          )}
          {latest.baselineMinutes != null && (
            <Badge>≈ {latest.baselineMinutes} min manual</Badge>
          )}
          {Array.isArray(latest.mcpServers) && latest.mcpServers.length > 0 && (
            <Badge>
              {latest.mcpServers.length} MCP server
              {latest.mcpServers.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      )}

      {latest && (
        <details className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
          <summary className="cursor-pointer text-sm text-neutral-400">
            Skill instructions
          </summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-sm text-neutral-300">
            {latest.instructions}
          </pre>
        </details>
      )}

      <KnowledgeScope
        slug={skill.slug}
        collection={skill.knowledgeCollection}
        collections={collections}
      />

      <RunPanel slug={skill.slug} baselineMinutes={latest?.baselineMinutes ?? null} />
    </main>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-0.5 text-neutral-400">
      {children}
    </span>
  );
}
