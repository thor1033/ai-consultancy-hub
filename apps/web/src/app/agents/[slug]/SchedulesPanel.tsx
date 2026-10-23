"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Schedule, Skill, SkillParameter } from "@ai-hub/db";
import { DAYS, cadence, rel } from "@/lib/format";
import {
  createScheduleAction,
  deleteScheduleAction,
  runScheduleNowAction,
  setScheduleEnabledAction,
  type ScheduleDraft,
} from "../actions";

// The agent's clock. Any skill it has, or a prompt, at a time, as the person
// who sets it up. Nothing here knows what the work is: a morning meeting brief,
// an hourly inbox poll and a Friday report are the same three fields.

const toMinute = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
};

interface Draft {
  name: string;
  what: "skill" | "prompt";
  skillId: string;
  args: Record<string, string>;
  prompt: string;
  kind: "every" | "daily";
  intervalMinutes: string;
  at: string;
  weekdays: number[];
  timezone: string;
}

export function SchedulesPanel({
  agentId,
  skills,
  initial,
  viewerId,
  isAdmin,
  canSchedule,
  timezone,
}: {
  agentId: string;
  skills: Skill[];
  initial: Schedule[];
  viewerId: string | null;
  isAdmin: boolean;
  /** False when the agent runs in Claude Code only: the hub has no clock for it. */
  canSchedule: boolean;
  timezone: string;
}) {
  const router = useRouter();
  const [schedules, setSchedules] = useState<Schedule[]>(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const usable = skills.filter((s) => s.enabled);
  const now = Date.now();

  const apply = (res: { schedules: Schedule[] } | { error: string }, done?: string) => {
    if ("error" in res) setMessage({ text: res.error, error: true });
    else {
      setSchedules(res.schedules);
      setMessage(done ? { text: done, error: false } : null);
      router.refresh();
    }
  };

  function blank(): Draft {
    return {
      name: "",
      what: usable.length ? "skill" : "prompt",
      skillId: usable[0]?.id ?? "",
      args: {},
      prompt: "",
      kind: "daily",
      intervalMinutes: "60",
      at: "07:00",
      weekdays: [1, 2, 3, 4, 5],
      timezone,
    };
  }

  function submit() {
    if (!draft) return;
    const input: ScheduleDraft = {
      agentId,
      name: draft.name,
      kind: draft.kind,
      timezone: draft.timezone,
      ...(draft.what === "skill" ? { skillId: draft.skillId, skillArgs: draft.args } : { prompt: draft.prompt }),
      ...(draft.kind === "every"
        ? { intervalMinutes: Number(draft.intervalMinutes) }
        : { atMinute: toMinute(draft.at), weekdays: draft.weekdays }),
    };
    start(async () => {
      const res = await createScheduleAction(input);
      if (!("error" in res)) setDraft(null);
      apply(res, "Scheduled.");
    });
  }

  const skill = usable.find((s) => s.id === draft?.skillId);

  return (
    <section className="panel p-5 md:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <div className="eyebrow">Schedules</div>
        {!draft && canSchedule && viewerId && (
          <button type="button" className="btn min-h-9 text-xs" onClick={() => { setMessage(null); setDraft(blank()); }}>
            Add a schedule
          </button>
        )}
      </div>

      {schedules.length === 0 && !draft ? (
        <p className="mt-3 text-sm text-[var(--muted)]">
          {canSchedule
            ? "None. A schedule runs one of this agent's skills, or a prompt, on a timer, as the person who set it up."
            : "This agent runs in Claude Code only, so the hub has no clock for it."}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {schedules.map((s) => {
            const mine = s.ownerPrincipalId === viewerId;
            const may = mine || isAdmin;
            const sk = s.agentSkillId ? skills.find((k) => k.id === s.agentSkillId) : null;
            return (
              <li key={s.id} className={`border-t border-[var(--border)] py-3 first:border-t-0 first:pt-0 ${s.enabled ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-medium">{s.name}</span>
                  <span className="eyebrow shrink-0">{s.enabled ? "On" : "Off"}</span>
                </div>
                <p className="mt-0.5 text-sm text-[var(--text-soft)]">
                  {cadence(s)}
                  {s.kind === "daily" && <span className="text-[var(--muted)]"> · {s.timezone}</span>}
                  {" · "}
                  {sk ? (
                    <>
                      runs <span className="mono">{sk.slug}</span>
                      {Object.keys(s.skillArgs ?? {}).length > 0 && (
                        <span className="text-[var(--muted)]">
                          {" "}
                          ({Object.entries(s.skillArgs).map(([k, v]) => `${k} = ${String(v)}`).join(", ")})
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-[var(--muted)]">asks: “{s.prompt.length > 90 ? `${s.prompt.slice(0, 90)}…` : s.prompt}”</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  Last ran {rel(s.lastRunAt, now).toLowerCase()} · as <span className="mono">{mine ? "you" : s.ownerPrincipalId}</span>
                </p>
                {s.lastError && <p className="mt-1 line-clamp-2 text-xs text-[var(--danger)]">{s.lastError}</p>}
                {viewerId && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <button
                      type="button"
                      className="btn min-h-8"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const res = await runScheduleNowAction(s.id);
                          if ("error" in res) setMessage({ text: res.error, error: true });
                          else {
                            setMessage({ text: res.running ? "Started. It will show under Recent runs as it finishes." : "Done. See Recent runs.", error: false });
                            router.refresh();
                          }
                        })
                      }
                    >
                      Run now, as you
                    </button>
                    {may && (
                      <button type="button" className="btn min-h-8" disabled={pending} onClick={() => start(async () => apply(await setScheduleEnabledAction(s.id, !s.enabled)))}>
                        {s.enabled ? "Switch off" : "Switch on"}
                      </button>
                    )}
                    {may && confirmDelete !== s.id && (
                      <button type="button" className="btn min-h-8" disabled={pending} onClick={() => setConfirmDelete(s.id)}>
                        Delete
                      </button>
                    )}
                    {may && confirmDelete === s.id && (
                      <>
                        <span className="self-center text-[var(--muted)]">Delete this schedule?</span>
                        <button type="button" className="btn-brand min-h-8" disabled={pending} onClick={() => start(async () => { setConfirmDelete(null); apply(await deleteScheduleAction(s.id), "Deleted."); })}>
                          Yes, delete
                        </button>
                        <button type="button" className="btn min-h-8" onClick={() => setConfirmDelete(null)}>
                          Keep
                        </button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {draft && (
        <form
          className="mt-4 border-t border-[var(--border-strong)] pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--muted)]">Name</span>
            <input className="field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Morning meeting prep" required />
          </label>

          <fieldset className="mt-4">
            <legend className="mb-1 block text-xs text-[var(--muted)]">What runs</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className={`flex items-center gap-2 ${usable.length ? "" : "opacity-50"}`}>
                <input type="radio" name="what" className="h-4 w-4 accent-[var(--text)]" checked={draft.what === "skill"} disabled={!usable.length} onChange={() => setDraft({ ...draft, what: "skill" })} />
                One of its skills
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="what" className="h-4 w-4 accent-[var(--text)]" checked={draft.what === "prompt"} onChange={() => setDraft({ ...draft, what: "prompt" })} />
                A prompt
              </label>
            </div>
            {draft.what === "skill" ? (
              <div className="mt-3 grid gap-3">
                <select className="field max-w-md" value={draft.skillId} onChange={(e) => setDraft({ ...draft, skillId: e.target.value, args: {} })}>
                  {usable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {skill && (skill.parameters ?? []).length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(skill.parameters ?? []).map((p) => (
                      <ParameterField key={p.name} p={p} value={draft.args[p.name] ?? ""} onChange={(v) => setDraft({ ...draft, args: { ...draft.args, [p.name]: v } })} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <textarea
                className="field mt-3 min-h-24 text-sm"
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                placeholder="What is on today, and what needs an answer?"
              />
            )}
          </fieldset>

          <fieldset className="mt-4">
            <legend className="mb-1 block text-xs text-[var(--muted)]">When</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="kind" className="h-4 w-4 accent-[var(--text)]" checked={draft.kind === "daily"} onChange={() => setDraft({ ...draft, kind: "daily" })} />
                At a time of day
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="kind" className="h-4 w-4 accent-[var(--text)]" checked={draft.kind === "every"} onChange={() => setDraft({ ...draft, kind: "every" })} />
                Every so many minutes
              </label>
            </div>
            {draft.kind === "daily" ? (
              <div className="mt-3 flex flex-wrap items-end gap-4">
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--muted)]">At</span>
                  <input type="time" className="field mono" value={draft.at} onChange={(e) => setDraft({ ...draft, at: e.target.value })} required />
                </label>
                <div>
                  <span className="mb-1 block text-xs text-[var(--muted)]">On</span>
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                      const on = draft.weekdays.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          className={`min-h-9 border px-2.5 text-xs ${on ? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]" : "border-[var(--border-strong)] text-[var(--muted)]"}`}
                          onClick={() => setDraft({ ...draft, weekdays: on ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d] })}
                        >
                          {DAYS[d]}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--muted)]">Timezone</span>
                  <input className="field mono" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} />
                </label>
              </div>
            ) : (
              <label className="mt-3 block max-w-xs">
                <span className="mb-1 block text-xs text-[var(--muted)]">Minutes between runs</span>
                <input type="number" min={1} className="field mono" value={draft.intervalMinutes} onChange={(e) => setDraft({ ...draft, intervalMinutes: e.target.value })} />
              </label>
            )}
            <p className="mt-2 text-xs text-[var(--muted)]">
              It runs as you, with what you may read, and stops if your access is removed. No day ticked means every day.
            </p>
          </fieldset>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" className="btn-brand min-h-11" disabled={pending || !draft.name.trim()}>
              {pending ? "Saving…" : "Schedule it"}
            </button>
            <button type="button" className="btn min-h-11" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {message && (
        <p role={message.error ? "alert" : "status"} className={`mt-3 text-sm ${message.error ? "text-[var(--danger)]" : "text-[var(--ai)]"}`}>
          {message.text}
        </p>
      )}
    </section>
  );
}

function ParameterField({ p, value, onChange }: { p: SkillParameter; value: string; onChange: (v: string) => void }) {
  const label = (
    <span className="mb-1 block text-xs text-[var(--muted)]">
      <span className="mono">{p.name}</span>
      {p.required ? "" : " (optional)"}
      {p.description ? ` — ${p.description}` : ""}
    </span>
  );
  if (p.options?.length) {
    return (
      <label className="block">
        {label}
        <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{p.required ? "Choose…" : "—"}</option>
          {p.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (p.type === "boolean") {
    return (
      <label className="flex items-center gap-2 self-end text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--text)]" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "")} />
        <span className="mono">{p.name}</span>
      </label>
    );
  }
  return (
    <label className="block">
      {label}
      <input className="field" type={p.type === "number" ? "number" : "text"} value={value} onChange={(e) => onChange(e.target.value)} required={Boolean(p.required)} />
    </label>
  );
}
