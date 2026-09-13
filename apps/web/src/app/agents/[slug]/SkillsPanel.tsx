"use client";

import { useState } from "react";
import {
  saveSkillAction,
  setSkillEnabledAction,
  deleteSkillAction,
} from "../actions";
import type { Skill, SkillParameter } from "@ai-hub/db";

/*
 * Where an agent's expertise gets defined.
 *
 * The framing is the one we use with clients: an Agent is an employee, a Skill
 * is something they know how to do. Concretely it is a prompt with blanks, and
 * the blanks become the arguments of a tool in everyone's editor — so the task
 * an expert worked out once turns into something a colleague invokes without
 * being told how.
 */

const EMPTY = {
  id: undefined as string | undefined,
  slug: "",
  name: "",
  description: "",
  promptTemplate: "",
  parameters: [] as SkillParameter[],
};

export function SkillsPanel({
  agentId,
  initial,
}: {
  agentId: string;
  initial: Skill[];
}) {
  const [skills, setSkills] = useState<Skill[]>(initial);
  const [draft, setDraft] = useState<typeof EMPTY | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function apply(out: { skills?: Skill[]; error?: string }) {
    if (out.error) setError(out.error);
    else if (out.skills) {
      setSkills(out.skills);
      setError(null);
      setDraft(null);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    apply(await saveSkillAction({ ...draft, agentId }));
    setBusy(false);
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Skills</h2>
          <p className="mt-0.5 text-sm text-[var(--muted)]">
            What this agent knows how to do. Each one becomes a tool in every connected
            client — Claude Code, VS Code, Cursor — with its blanks as real arguments.
          </p>
        </div>
        {!draft && (
          <button className="btn-brand shrink-0" onClick={() => setDraft({ ...EMPTY })}>
            Add skill
          </button>
        )}
      </div>

      {error && (
        <div className="panel mb-3 border-l-2 border-l-[var(--danger)] p-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {!skills.length && !draft && (
        <p className="panel p-4 text-sm text-[var(--muted)]">
          No skills yet. Without one, this agent is still reachable as{" "}
          <code>hub_agent_…</code> — a skill turns a specific task into its own tool.
        </p>
      )}

      <div className="space-y-2">
        {skills.map((s) => (
          <div
            key={s.id}
            className={`panel p-4 ${s.enabled ? "" : "opacity-65"}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-[var(--text)]">{s.name}</h3>
                  {!s.enabled && (
                    <span className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                      disabled
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-[var(--text-soft)]">{s.description}</p>
                <div className="mono mt-1 text-xs text-[var(--muted)]">
                  hub_skill_{s.slug.replace(/-/g, "_")}
                  {s.parameters?.length
                    ? ` (${s.parameters.map((p) => p.name + (p.required ? "" : "?")).join(", ")})`
                    : " (no arguments)"}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  className="chip"
                  onClick={() =>
                    setDraft({
                      id: s.id,
                      slug: s.slug,
                      name: s.name,
                      description: s.description,
                      promptTemplate: s.promptTemplate,
                      parameters: s.parameters ?? [],
                    })
                  }
                >
                  Edit
                </button>
                <button
                  className="chip"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    apply(await setSkillEnabledAction(s.id, agentId, !s.enabled));
                    setBusy(false);
                  }}
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="chip text-[var(--danger)]"
                  disabled={busy}
                  onClick={async () => {
                    if (!confirm(`Delete "${s.name}"? It disappears from every client.`)) return;
                    setBusy(true);
                    apply(await deleteSkillAction(s.id, agentId));
                    setBusy(false);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <div className="panel mt-3 p-4">
          <h3 className="text-sm font-semibold">
            {draft.id ? "Edit skill" : "New skill"}
          </h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field
              label="Name"
              value={draft.name}
              onChange={(name) =>
                setDraft({
                  ...draft,
                  name,
                  // Derived while the slug is untouched, so the common case needs
                  // no thought and a deliberate edit is still respected.
                  slug: draft.id ? draft.slug : slugify(name),
                })
              }
              placeholder="Weekly client deck"
            />
            <Field
              label="Slug (becomes the tool name)"
              value={draft.slug}
              onChange={(slug) => setDraft({ ...draft, slug })}
              placeholder="weekly-client-deck"
            />
          </div>
          <div className="mt-3">
            <Field
              label="What it does — the calling model reads this to decide when to use it"
              value={draft.description}
              onChange={(description) => setDraft({ ...draft, description })}
              placeholder="Draft the weekly delivery update for a client, from PM-tool and the knowledge base."
            />
          </div>

          <label className="mt-3 block">
            <div className="mb-1 text-xs text-[var(--muted)]">
              The prompt. Write <code>{"{{name}}"}</code> where a value should go.
            </div>
            <textarea
              className="field min-h-32 font-mono text-xs"
              value={draft.promptTemplate}
              onChange={(e) => setDraft({ ...draft, promptTemplate: e.target.value })}
              placeholder={
                "Write the weekly delivery update for {{client}} covering {{week}}.\nPull current task status from PM-tool and check the knowledge base for commitments."
              }
            />
          </label>

          <ParameterEditor
            parameters={draft.parameters}
            template={draft.promptTemplate}
            onChange={(parameters) => setDraft({ ...draft, parameters })}
          />

          <div className="mt-4 flex gap-2">
            <button className="btn-brand" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save skill"}
            </button>
            <button className="chip" onClick={() => { setDraft(null); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ParameterEditor({
  parameters,
  template,
  onChange,
}: {
  parameters: SkillParameter[];
  template: string;
  onChange: (p: SkillParameter[]) => void;
}) {
  // Placeholders in the prompt with no parameter behind them. Offered as a
  // one-click fix because this is the mistake everyone makes, and the failure
  // it causes — a literal "{{client}}" in a client-facing document — surfaces
  // far from its cause.
  const declared = new Set(parameters.map((p) => p.name));
  const missing = [
    ...new Set(Array.from(template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g), (m) => m[1])),
  ].filter((n) => !declared.has(n));

  const update = (i: number, patch: Partial<SkillParameter>) =>
    onChange(parameters.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs text-[var(--muted)]">Arguments</div>
        <button
          type="button"
          className="chip"
          onClick={() =>
            onChange([...parameters, { name: "", description: "", required: true }])
          }
        >
          Add argument
        </button>
      </div>

      {missing.length > 0 && (
        <div className="mb-2 rounded-lg border border-[var(--border)] border-l-2 border-l-[var(--danger)] p-3 text-sm">
          The prompt uses{" "}
          {missing.map((n) => (
            <code key={n} className="mr-1">{`{{${n}}}`}</code>
          ))}
          with no argument behind it.{" "}
          <button
            type="button"
            className="underline"
            onClick={() =>
              onChange([
                ...parameters,
                ...missing.map((name) => ({ name, description: "", required: true })),
              ])
            }
          >
            Add {missing.length === 1 ? "it" : "them"}
          </button>
          .
        </div>
      )}

      <div className="space-y-2">
        {parameters.map((p, i) => (
          <div key={i} className="rounded-lg border border-[var(--border)] p-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                className="field"
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="client"
              />
              <input
                className="field sm:col-span-2"
                value={p.description}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="Which client the update is for."
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <select
                className="field max-w-36"
                value={p.type ?? "string"}
                onChange={(e) => update(i, { type: e.target.value as SkillParameter["type"] })}
              >
                <option value="string">text</option>
                <option value="number">number</option>
                <option value="boolean">yes / no</option>
              </select>
              <label className="flex items-center gap-2 text-sm text-[var(--text-soft)]">
                <input
                  type="checkbox"
                  checked={p.required !== false}
                  onChange={(e) => update(i, { required: e.target.checked })}
                />
                Required
              </label>
              <input
                className="field min-w-48 flex-1"
                value={(p.options ?? []).join(", ")}
                onChange={(e) =>
                  update(i, {
                    options: e.target.value
                      .split(",")
                      .map((o) => o.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="Fixed choices, comma separated (optional)"
              />
              <button
                type="button"
                className="chip text-[var(--danger)]"
                onClick={() => onChange(parameters.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-[var(--muted)]">{label}</div>
      <input
        className="field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
