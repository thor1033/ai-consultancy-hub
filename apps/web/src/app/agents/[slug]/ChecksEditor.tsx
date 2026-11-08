"use client";

// The pure checks module, not the package root: this is a client component, and the root opens Postgres.
import { CHECK_KINDS, CHECK_WORDS, type SkillCheck, type CheckKind } from "@ai-hub/db/checks";

/*
 * Checks on every answer (docs/effective-agents-review.md, D1). The plain
 * kinds are decided in code; "Meets this standard" is read by a second model.
 * The verdict shows under the answer, in the runner and under Your answers;
 * it never blocks the answer.
 */
export function ChecksEditor({ checks, onChange }: { checks: SkillCheck[]; onChange: (c: SkillCheck[]) => void }) {
  const update = (i: number, patch: Partial<SkillCheck>) => onChange(checks.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs text-[var(--muted)]">
          Checks on every answer. Each is judged when the run finishes and shown under the answer; a failed check is said, not hidden.
        </span>
        <button type="button" className="btn min-h-9 text-xs" onClick={() => onChange([...checks, { kind: "mentions", value: "" }])}>
          Add a check
        </button>
      </div>
      {checks.length === 0 && (
        <p className="mt-2 text-xs text-[var(--muted)]">None yet. A word limit and one standard a reader could check are a good start.</p>
      )}
      <ul className="mt-2 flex flex-col gap-3">
        {checks.map((c, i) => (
          <li key={i} className="inset grid gap-2 p-3 sm:grid-cols-[12rem_1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--muted)]">Kind</span>
              <select className="field" value={c.kind} onChange={(e) => update(i, { kind: e.target.value as CheckKind, ...(e.target.value === "writes" ? {} : { tool: undefined }) })}>
                {CHECK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CHECK_WORDS[k].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-2">
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--muted)]">{CHECK_WORDS[c.kind]?.help ?? ""}</span>
                {c.kind === "judge" ? (
                  <textarea
                    className="field min-h-20 text-sm leading-relaxed"
                    value={c.value}
                    onChange={(e) => update(i, { value: e.target.value })}
                    placeholder={"1. Names the client and the week.\n2. Every late task says what it blocks.\n3. Ends with the one decision needed."}
                  />
                ) : (
                  <input
                    className={`field ${c.kind === "maxWords" || c.kind === "writes" ? "mono" : ""}`}
                    inputMode={c.kind === "maxWords" || c.kind === "writes" ? "numeric" : undefined}
                    value={c.value}
                    onChange={(e) => update(i, { value: e.target.value })}
                    placeholder={c.kind === "maxWords" ? "400" : c.kind === "writes" ? "0" : "e.g. a price"}
                  />
                )}
              </label>
              {c.kind === "writes" && (
                <Field label="Only this tool (optional)" value={c.tool ?? ""} onChange={(tool) => update(i, { tool: tool || undefined })} placeholder="pm_create_task" mono />
              )}
            </div>
            <button type="button" className="btn min-h-9 self-start text-xs" onClick={() => onChange(checks.filter((_, j) => j !== i))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-[var(--muted)]">{label}</span>
      <input
        className={`field ${mono ? "mono" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
