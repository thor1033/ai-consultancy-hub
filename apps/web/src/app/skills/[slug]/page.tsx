import Link from "next/link";
import { notFound } from "next/navigation";
import { getSkill, listSchedulesForSkill, type SkillSchedule } from "@ai-hub/db";
import { listCollections } from "@ai-hub/rag";
import { RunPanel } from "./RunPanel";
import { KnowledgeScope } from "./KnowledgeScope";
import { SkillSchedules } from "./SkillSchedules";

export const dynamic = "force-dynamic";

export default async function SkillPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let skill: Awaited<ReturnType<typeof getSkill>> = null;
  let collections: string[] = [];
  let schedules: SkillSchedule[] = [];
  let error: string | null = null;
  try {
    [skill, collections, schedules] = await Promise.all([
      getSkill(slug),
      listCollections(),
      listSchedulesForSkill(slug),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load skill.";
  }

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-7 lg:px-8">
        <div className="panel border-l-2 border-l-[var(--warning)] p-4 text-sm text-[var(--warning)]">
          Couldn&apos;t load this skill: {error}
        </div>
      </main>
    );
  }

  if (!skill) notFound();

  const latest = skill.versions[0];

  return (
    <main className="mx-auto max-w-3xl px-5 py-7 lg:px-8">
      <Link href="/" className="chip mb-5">
        ← Overview
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{skill.name}</h1>
          <p className="mt-1 text-[var(--muted)]">{skill.description || "No description."}</p>
        </div>
        <span className="chip mono shrink-0">v{skill.latestVersion ?? "—"}</span>
      </div>

      {latest && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {latest.model && <span className="chip mono">{latest.model}</span>}
          {latest.baselineMinutes != null && (
            <span className="chip">≈ {latest.baselineMinutes} min manual</span>
          )}
          {Array.isArray(latest.mcpServers) && latest.mcpServers.length > 0 && (
            <span className="chip">
              {latest.mcpServers.length} MCP server{latest.mcpServers.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}

      {latest && (
        <details className="panel mt-6 p-4">
          <summary className="cursor-pointer text-sm text-[var(--text-soft)]">
            Skill instructions
          </summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-sm text-[var(--text-soft)]">
            {latest.instructions}
          </pre>
        </details>
      )}

      <KnowledgeScope
        slug={skill.slug}
        collection={skill.knowledgeCollection}
        collections={collections}
      />

      <SkillSchedules slug={skill.slug} initial={schedules} />

      <RunPanel slug={skill.slug} baselineMinutes={latest?.baselineMinutes ?? null} />
    </main>
  );
}
