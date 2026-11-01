import Link from "next/link";
import { PATTERNS, COMMON_PARAMS } from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";
import { viewContext } from "@/lib/viewServer";
import { PatternPicker, type PatternView } from "./PatternPicker";

export const dynamic = "force-dynamic";

// Premade sets of agents that work together (docs/agent-patterns.md). The
// list and each pattern's text come from code; this page only lays them out
// and hands the filled-in values to the action that creates the rows.

export default async function PatternsPage() {
  const canManage = Boolean(await sessionCan("agent:manage"));
  const expert = (await viewContext()).view === "expert";
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
        <h1 className="mt-3 text-3xl md:text-4xl">Hire a team, not an agent.</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          {expert
            ? "A pattern is a few agents and the wiring between them: who remembers, who starts clean, who may ask whom while it runs, and what starts when what finishes. Pick one, name it, and it becomes ordinary agents on the org chart."
            : "A few agents that already know how to work together. Pick the one that sounds like your situation, fill in the names, and look at what it will make before you say yes. You can change every agent afterwards."}
        </p>
      </header>
      <PatternPicker patterns={patterns} canManage={canManage} />
    </main>
  );
}
