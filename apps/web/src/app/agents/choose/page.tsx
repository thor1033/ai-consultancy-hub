import Link from "next/link";
import { PATTERNS } from "@ai-hub/db";
import { viewContext } from "@/lib/viewServer";

export const dynamic = "force-dynamic";

/*
 * Which shape? (docs/effective-agents-review.md, A1.)
 *
 * Anthropic's first rule for agents is to start with one model call and add
 * a step only when it demonstrably helps: every extra agent costs time and
 * money on every run. So the first row is one agent, and it is the answer
 * for most jobs. The rows after it are the patterns, each as the one
 * question that says it is the right shape — the question each pattern
 * carries in code, so the chooser and the pattern never disagree.
 */
export default async function ChoosePage() {
  const expert = (await viewContext()).view === "expert";
  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← Agents
      </Link>
      <header className="mt-3">
        <div className="eyebrow">Agents / Which shape</div>
        <h1 className="mt-3 text-3xl md:text-4xl">One agent, or a team?</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          Read down until a question is a yes. Most jobs stop at the first row: one agent with a good brief and the right tools. Every
          extra agent costs time and money on every run, so reach for a team only when one agent demonstrably cannot do the job.
        </p>
      </header>

      <ol className="mt-6 flex flex-col gap-3">
        <li>
          <Link href="/agents/new" className="panel panel-hover block border-l-2 border-l-[var(--brand)] p-5">
            <div className="text-xs font-medium text-[var(--muted)]">Start here</div>
            <div className="mt-1 text-lg font-bold">Is it one kind of job, done the same way each time, with an answer a person reads?</div>
            <div className="mt-2 text-sm text-[var(--text-soft)]">
              <strong>One agent.</strong> Give it a brief, the tools it needs and a skill for the job. If its answers fall short, fix the brief
              first; a second agent is the last fix, not the first.
            </div>
          </Link>
        </li>
        {PATTERNS.map((p, i) => (
          <li key={p.slug}>
            <Link href={`/agents/patterns?pattern=${encodeURIComponent(p.slug)}`} className="panel panel-hover block border-l-2 border-l-transparent p-5">
              <div className="text-xs font-medium text-[var(--muted)]">Or, {i + 2} of {PATTERNS.length + 1}</div>
              <div className="mt-1 text-lg font-bold">{p.question}</div>
              <div className="mt-2 text-sm text-[var(--text-soft)]">
                <strong>{expert ? `${p.nickname} (${p.name})` : p.name}.</strong> {p.summary}
              </div>
            </Link>
          </li>
        ))}
      </ol>

      <p className="mt-6 max-w-2xl text-sm text-[var(--muted)]">
        Not sure? Start with one agent. You can hire the rest of a team around it later, and nothing you wrote is lost: a pattern
        creates agents you can change, and an agent can be given colleagues to ask on its page.
      </p>
    </main>
  );
}
