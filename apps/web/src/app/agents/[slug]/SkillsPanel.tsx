"use client";

import { useState } from "react";
import { saveSkillAction, setSkillEnabledAction, deleteSkillAction } from "../actions";
import type { Skill, SkillParameter } from "@ai-hub/db";
import { agentToolName, skillToolName } from "../models";

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
  agentSlug,
  initial,
}: {
  agentId: string;
  agentSlug: string;
  initial: Skill[];
}) {
  const [skills, setSkills] = useState<Skill[]>(initial);
  const [draft, setDraft] = useState<typeof EMPTY | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function apply(out: { skills?: Skill[]; error?: string }) {
    if (out.error) setError(out.error);
    else if (out.skills) {
      setSkills(out.skills);
      setError(null);
      setDraft(null);
      setConfirmDelete(null);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    apply(await saveSkillAction({ ...draft, agentId }));
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <p className="max-w-2xl text-sm text-[var(--muted)]">
          What this agent knows how to do. Each skill becomes its own tool in every connected client — Claude Code,
          VS Code, Cursor — with its blanks as real arguments.
        </p>
        {!draft && (
          <button className="btn-brand min-h-11 shrink-0" onClick={() => setDraft({ ...EMPTY })}>
            Add skill
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="panel notice-danger p-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {draft && (
        <SkillEditor
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSave={save}
          onCancel={() => {
            setDraft(null);
            setError(null);
          }}
        />
      )}

      {!skills.length && !draft && (
        <div className="panel p-6 md:p-8">
          <div className="eyebrow">No skills yet</div>
          <p className="mt-2 max-w-xl text-[var(--text-soft)]">
            The agent is still reachable as <span className="mono text-sm">{agentToolName(agentSlug)}</span>. A skill
            turns one specific task — a weekly update, a board sweep — into a tool of its own that a colleague can call
            without knowing how it is done.
          </p>
        </div>
      )}

      {skills.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2">
          {skills.map((s) => (
            <li key={s.id} className={`panel flex flex-col p-5 ${s.enabled ? "" : "opacity-65"}`}>
              <div className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className="mt-2 inline-block h-2 w-2 shrink-0 rotate-45"
                  style={{ background: s.enabled ? "var(--c-skill)" : "var(--faint)" }}
                />
                <div className="min-w-0">
                  <h3 className="text-base font-bold">
                    {s.name}
                    {!s.enabled && <span className="eyebrow ml-2 align-middle">Off</span>}
                  </h3>
                  <p className="mt-1 text-sm text-[var(--text-soft)]">
                    {s.description || <span className="text-[var(--muted)]">No description.</span>}
                  </p>
                </div>
              </div>
              <div className="inset mono mt-3 break-all px-3 py-2 text-xs">
                {skillToolName(s.slug)}(
                {s.parameters?.length ? (
                  s.parameters.map((p, i) => (
                    <span key={p.name}>
                      {i > 0 && ", "}
                      <span className="text-[var(--c-skill)]">{p.name}</span>
                      {p.required === false && <span className="text-[var(--muted)]">?</span>}
                    </span>
                  ))
                ) : (
                  <span className="text-[var(--muted)]">no arguments</span>
                )}
                )
              </div>
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                {confirmDelete === s.id ? (
                  <>
                    <button
                      className="btn min-h-9 border-[var(--danger)] text-[var(--danger)]"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        apply(await deleteSkillAction(s.id, agentId));
                        setBusy(false);
                      }}
                    >
                      Delete — it leaves every client
                    </button>
                    <button className="btn min-h-9" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn min-h-9"
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
                      className="btn min-h-9"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        apply(await setSkillEnabledAction(s.id, agentId, !s.enabled));
                        setBusy(false);
                      }}
                    >
                      {s.enabled ? "Switch off" : "Switch on"}
                    </button>
                    <button className="btn min-h-9" disabled={busy} onClick={() => setConfirmDelete(s.id)}>
                      Delete…
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillEditor({
  draft,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: typeof EMPTY;
  busy: boolean;
  onChange: (d: typeof EMPTY) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="panel border-[var(--text)] p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg">{draft.id ? `Edit ${draft.name || "skill"}` : "New skill"}</h3>
        <span className="mono text-xs text-[var(--muted)]">{skillToolName(draft.slug || "…")}</span>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          value={draft.name}
          onChange={(name) =>
            onChange({
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
          label="Slug — becomes the tool name"
          value={draft.slug}
          onChange={(slug) => onChange({ ...draft, slug })}
          placeholder="weekly-client-deck"
          mono
        />
      </div>
      <div className="mt-4">
        <Field
          label="What it does — the calling model reads this to decide when to use it"
          value={draft.description}
          onChange={(description) => onChange({ ...draft, description })}
          placeholder="Draft the weekly delivery update for a client, from PM-tool and the knowledge base."
        />
      </div>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">
          The prompt. Write <span className="mono">{"{{name}}"}</span> where an argument should go.
        </span>
        <textarea
          className="field mono min-h-36 text-xs leading-relaxed"
          value={draft.promptTemplate}
          onChange={(e) => onChange({ ...draft, promptTemplate: e.target.value })}
          placeholder={
            "Write the weekly delivery update for {{client}} covering {{week}}.\nPull current task status from PM-tool and check the knowledge base for commitments."
          }
        />
      </label>

      <ParameterEditor
        parameters={draft.parameters}
        template={draft.promptTemplate}
        onChange={(parameters) => onChange({ ...draft, parameters })}
      />

      <div className="mt-5 flex flex-wrap gap-2">
        <button className="btn-brand min-h-11" disabled={busy} onClick={onSave}>
          {busy ? "Saving…" : "Save skill"}
        </button>
        <button className="btn min-h-11" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
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
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">Arguments</span>
        <button
          type="button"
          className="btn min-h-9"
          onClick={() => onChange([...parameters, { name: "", description: "", required: true }])}
        >
          Add argument
        </button>
      </div>

      {missing.length > 0 && (
        <div className="notice-danger mb-2 border border-[var(--danger)] p-3 text-sm">
          The prompt uses{" "}
          {missing.map((n) => (
            <span key={n} className="mono mr-1">{`{{${n}}}`}</span>
          ))}
          with no argument behind it.{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={() =>
              onChange([...parameters, ...missing.map((name) => ({ name, description: "", required: true }))])
            }
          >
            Add {missing.length === 1 ? "it" : "them"}
          </button>
        </div>
      )}

      {parameters.length === 0 && missing.length === 0 && (
        <p className="inset p-3 text-sm text-[var(--muted)]">
          None — the skill runs the same prompt every time.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {parameters.map((p, i) => (
          <div key={i} className="inset p-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                className="field mono"
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="client"
                aria-label="Argument name"
              />
              <input
                className="field sm:col-span-2"
                value={p.description}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="Which client the update is for."
                aria-label="Argument description"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <select
                className="field max-w-36"
                value={p.type ?? "string"}
                onChange={(e) => update(i, { type: e.target.value as SkillParameter["type"] })}
                aria-label="Argument type"
              >
                <option value="string">text</option>
                <option value="number">number</option>
                <option value="boolean">yes / no</option>
              </select>
              <label className="flex min-h-9 items-center gap-2 text-sm text-[var(--text-soft)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--text)]"
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
                aria-label="Fixed choices"
              />
              <button
                type="button"
                className="btn min-h-9 text-[var(--danger)]"
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
