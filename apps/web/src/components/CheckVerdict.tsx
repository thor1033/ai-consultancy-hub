// The pure checks module, not the package root: the runner renders this in the browser.
import { summarizeChecks, type CheckResult } from "@ai-hub/db/checks";

// The verdict of a skill's checks under its answer (docs/effective-agents-review.md,
// D1): one line, then each check that failed or could not be judged. No hooks,
// so the runner (client) and Your answers (server) share it. Null when the
// skill had no checks: an answer with nothing to check says nothing.

export function CheckVerdict({ checks }: { checks: CheckResult[] | null | undefined }) {
  const line = summarizeChecks(checks);
  if (!line || !checks) return null;
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === null);
  const allGood = failed.length === 0 && unknown.length === 0;
  return (
    <div className={`mt-3 border-l-2 pl-3 text-sm ${allGood ? "border-[var(--ai)]" : failed.length ? "border-[var(--brand)]" : "border-[var(--muted)]"}`}>
      <p className={allGood ? "text-[var(--muted)]" : ""}>{line}</p>
      {(failed.length > 0 || unknown.length > 0) && (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-[var(--muted)]">
          {[...failed, ...unknown].map((c, i) => (
            <li key={i}>
              <span className={c.ok === false ? "text-[var(--brand)]" : ""}>{c.ok === false ? "Not met" : "Not judged"}</span>
              {" · "}
              {c.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
