import Link from "next/link";
import { listRunnableSkills, runsOnHub, type AgentRosterRow, type SkillWithAgent } from "@ai-hub/db";

// The agents as a person who uses them sees them (docs/views.md): who can
// help, with what, and one click to talk or to run a task. No owners,
// functions, figures or tools — that is the org chart, for Standard and up.
// Server component: it reads the runnable skills itself.

export async function AgentDirectory({ roster, canRun, limit }: { roster: AgentRosterRow[]; canRun: boolean; limit?: number }) {
  const skills: SkillWithAgent[] = await listRunnableSkills().catch(() => []);
  const agents = roster.filter((a) => a.enabled && runsOnHub(a.placement)).sort((x, y) => x.name.localeCompare(y.name));
  const shown = limit ? agents.slice(0, limit) : agents;
  if (agents.length === 0) {
    return (
      <p className="text-sm text-[var(--muted)]">
        No agents are set up for you yet. The person who runs the hub adds them; once they do, they appear here.
      </p>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {shown.map((a) => {
        const own = skills.filter((s) => s.agentId === a.id);
        return (
          <li key={a.id} className="panel flex flex-col p-5">
            <Link href={`/agents/${a.slug}`} className="text-lg font-bold leading-tight hover:text-[var(--brand)]">
              {a.name}
            </Link>
            <p className="mt-1.5 line-clamp-3 text-sm text-[var(--text-soft)]">{a.description || "Ask it anything in its area."}</p>
            {own.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {own.slice(0, 4).map((s) => (
                  <li key={s.id}>
                    <Link href={`/agents/${a.slug}#skills`} className="group flex items-baseline gap-2 text-[var(--text-soft)] hover:text-[var(--brand)]">
                      <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rotate-45 bg-[var(--c-skill)]" />
                      {s.name}
                    </Link>
                  </li>
                ))}
                {own.length > 4 && <li className="text-xs text-[var(--muted)]">and {own.length - 4} more</li>}
              </ul>
            )}
            {canRun && (
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Link href={`/agents/${a.slug}#conversation`} className="btn-brand min-h-10">
                  {/* Not "Talk to <first word>": names like "Product Owner — AI Hub" cut to nonsense, and the name is right above. */}
                  Ask a question
                </Link>
                {own.length > 0 && (
                  <Link href={`/agents/${a.slug}#skills`} className="btn min-h-10">
                    Run a task
                  </Link>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
