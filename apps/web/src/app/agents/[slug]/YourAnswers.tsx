import type { MyRun } from "@ai-hub/db";
import { Markdown } from "@/components/Markdown";
import { rel } from "@/lib/format";

// "Your answers" on an agent's page (docs/views.md): what you asked this agent
// — in a chat, from a skill's form, on a schedule — and what came back. A long
// skill run tells the person they may leave the page; this is where the answer
// waits for them. Only their own runs are listed (listMyRuns), so nobody reads
// anyone else's answers here, whatever their role.

const firstLine = (s: string) => {
  const line = s.trim().split("\n").find((l) => l.trim()) ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

// "succeeded" today; anything that is neither running nor failed has ended, as runStatusAction reads it.
const finished = (r: MyRun) => r.status !== "running" && r.status !== "failed";

export function YourAnswers({ runs, agentName, now }: { runs: MyRun[]; agentName: string; now: number }) {
  if (runs.length === 0) {
    return (
      <div className="panel p-5 md:p-6">
        <p className="text-sm text-[var(--muted)]">
          Nothing yet. When you ask {agentName} something or run one of its skills, the answer is kept here for you — and only you.
        </p>
      </div>
    );
  }
  return (
    <div className="panel p-5 md:p-6">
      <p className="text-sm text-[var(--muted)]">What you asked {agentName}, newest first. Only you can see these.</p>
      <ul className="mt-3 flex flex-col">
        {runs.map((r, i) => (
          <li key={r.id} className="border-t border-[var(--border)] py-3">
            <details open={i === 0 && finished(r)}>
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 shrink-0 ${r.status === "running" ? "ctx-blink" : ""}`}
                  style={{ background: r.status === "failed" ? "var(--brand)" : r.status === "running" ? "var(--muted)" : "var(--ai)" }}
                />
                <span className="min-w-0 flex-1 text-sm font-medium">{r.skill ?? (r.expired ? "A conversation" : firstLine(r.prompt))}</span>
                <span className="text-xs text-[var(--muted)]">
                  {r.status === "running" ? "Still working · " : r.status === "failed" ? "Did not finish · " : ""}
                  {rel(r.at, now)}
                </span>
              </summary>
              <div className="mt-3 pl-5">
                {r.skill && <p className="mb-2 text-xs text-[var(--muted)]">{firstLine(r.prompt)}</p>}
                {r.expired ? (
                  <p className="text-sm text-[var(--muted)]">The question and answer were removed after the hub&apos;s retention period. What remains is that it happened.</p>
                ) : finished(r) && r.output ? (
                  <div className="inset p-4">
                    <Markdown>{r.output}</Markdown>
                  </div>
                ) : r.status === "failed" ? (
                  <p className="text-sm text-[var(--danger)]">{r.error || "It stopped without an answer."}</p>
                ) : r.status === "running" ? (
                  <p className="text-sm text-[var(--muted)]">{agentName} is still on it. Come back in a few minutes, or reload this page.</p>
                ) : (
                  <p className="text-sm text-[var(--muted)]">No answer was kept.</p>
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
