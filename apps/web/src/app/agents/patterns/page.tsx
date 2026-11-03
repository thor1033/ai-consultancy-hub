import Link from "next/link";
import { PATTERNS, COMMON_PARAMS } from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";
import { viewContext } from "@/lib/viewServer";
import { PatternPicker, type PatternView } from "./PatternPicker";

export const dynamic = "force-dynamic";

// Premade sets of agents that work together (docs/agent-patterns.md). The
// list and each pattern's text come from code; this page only lays them out
// and hands the filled-in values to the action that creates the rows.

export default async function PatternsPage({ searchParams }: { searchParams?: Promise<{ pattern?: string }> }) {
  const canManage = Boolean(await sessionCan("agent:manage"));
  const expert = (await viewContext()).view === "expert";
  // The chooser (/agents/choose) deep-links to a pattern; an unknown slug opens the first.
  const wanted = (await searchParams)?.pattern;
  const initial = PATTERNS.some((p) => p.slug === wanted) ? wanted : undefined;
  const patterns: PatternView[] = PATTERNS.map((p) => ({
    slug: p.slug,
    name: p.name,
    nickname: p.nickname,
    summary: p.summary,
    when: p.when,
    diagram: p.diagram,
    decisions: p.decisions,
    params: [...COMMON_PARAMS, ...p.params].map((x) => ({ key: x.key, label: x.label, help: x.help, kind: x.kind, required: x.required, placeholder: x.placeholder, default: x.default })),
  }));

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← Agents
      </Link>
      <header className="mt-3">
        <div className="eyebrow">{expert ? "Agents / Patterns" : "Agents / Ready-made teams"}</div>
        <h1 className="mt-3 text-3xl md:text-4xl">A team, when one agent is not enough.</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          {expert
            ? "A pattern is a few agents and the wiring between them: who remembers, who starts clean, who may ask whom while it runs, and what starts when what finishes. Pick one, name it, and it becomes ordinary agents on the org chart."
            : "A few agents that already know how to work together. Pick the one that sounds like your situation, fill in the names, and look at what it will make before you say yes. You can change every agent afterwards."}
        </p>
        {/* One agent is the answer for most jobs (docs/effective-agents-review.md, A2): say so before the teams. */}
        <div className="mt-4 flex max-w-2xl flex-wrap gap-3">
          <Link href="/agents/new" className="panel panel-hover flex min-w-64 flex-1 items-center justify-between gap-4 p-4">
            <span>
              <span className="block font-bold">Most jobs need one agent</span>
              <span className="block text-sm text-[var(--muted)]">A good brief and the right tools. Start there; add colleagues when it falls short.</span>
            </span>
            <span aria-hidden className="text-[var(--muted)]">→</span>
          </Link>
          <Link href="/agents/choose" className="panel panel-hover flex min-w-64 flex-1 items-center justify-between gap-4 p-4">
            <span>
              <span className="block font-bold">Not sure which shape?</span>
              <span className="block text-sm text-[var(--muted)]">Six questions; read down until one is a yes.</span>
            </span>
            <span aria-hidden className="text-[var(--muted)]">→</span>
          </Link>
        </div>
      </header>
      <PatternPicker patterns={patterns} canManage={canManage} initial={initial} />
    </main>
  );
}
