"use client";

import { useState } from "react";
import type { SkillSchedule, ScheduleKind } from "@ai-hub/db";
import {
  createScheduleAction,
  toggleScheduleAction,
  deleteScheduleAction,
  type ScheduleForm,
} from "./actions";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describe(s: SkillSchedule): string {
  const t = s.timeOfDay ?? "";
  switch (s.kind) {
    case "once":
      return s.runAt ? `Once · ${fmtWhen(s.runAt)}` : "Once";
    case "daily":
      return `Every day at ${t}`;
    case "weekly":
      return `Every ${WEEKDAYS[s.weekday ?? 1]} at ${t}`;
    case "monthly":
      return `Monthly on day ${s.dayOfMonth ?? 1} at ${t}`;
    default:
      return s.kind;
  }
}

export function SkillSchedules({
  slug,
  initial,
}: {
  slug: string;
  initial: SkillSchedule[];
}) {
  const [schedules, setSchedules] = useState<SkillSchedule[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(initial.length === 0);

  function apply(out: { schedules: SkillSchedule[] } | { error: string }) {
    if ("error" in out) setError(out.error);
    else {
      setError(null);
      setSchedules(out.schedules);
    }
  }

  const active = schedules.filter((s) => s.enabled).length;

  return (
    <div className="panel mt-6 p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--muted)]">Automation</div>
          <p className="mt-0.5 text-sm text-[var(--muted)]">
            Run this skill automatically on a schedule.{" "}
            {active > 0 && (
              <span className="text-[var(--text-soft)]">{active} active.</span>
            )}
          </p>
        </div>
        <button className="btn" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "+ New schedule"}
        </button>
      </div>

      {error && <div className="mt-3 text-sm text-[var(--danger)]">{error}</div>}

      {open && <NewSchedule slug={slug} onDone={apply} />}

      {schedules.length > 0 && (
        <div className="mt-4 space-y-2">
          {schedules.map((s) => (
            <ScheduleRow key={s.id} slug={slug} sched={s} onDone={apply} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewSchedule({
  slug,
  onDone,
}: {
  slug: string;
  onDone: (out: { schedules: SkillSchedule[] } | { error: string }) => void;
}) {
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [runAtLocal, setRunAtLocal] = useState("");
  const [input, setInput] = useState("");
  const [retrieve, setRetrieve] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    const form: ScheduleForm = { input, retrieve, kind, timeOfDay, weekday, dayOfMonth, runAtLocal };
    const out = await createScheduleAction(slug, form);
    if (!("error" in out)) setInput("");
    onDone(out);
    setBusy(false);
  }

  return (
    <div className="inset mt-4 p-4">
      <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
        <label className="block">
          <div className="mb-1 text-xs text-[var(--muted)]">Frequency</div>
          <select value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)} className="field">
            <option value="once">Once</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>

        <div className="flex flex-wrap items-end gap-3">
          {kind === "once" ? (
            <label className="block">
              <div className="mb-1 text-xs text-[var(--muted)]">Date &amp; time</div>
              <input
                type="datetime-local"
                value={runAtLocal}
                onChange={(e) => setRunAtLocal(e.target.value)}
                className="field"
              />
            </label>
          ) : (
            <label className="block">
              <div className="mb-1 text-xs text-[var(--muted)]">At</div>
              <input
                type="time"
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                className="field"
              />
            </label>
          )}

          {kind === "weekly" && (
            <label className="block">
              <div className="mb-1 text-xs text-[var(--muted)]">Weekday</div>
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className="field">
                {WEEKDAYS.map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}

          {kind === "monthly" && (
            <label className="block">
              <div className="mb-1 text-xs text-[var(--muted)]">Day of month</div>
              <input
                type="number"
                min={1}
                max={28}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Number(e.target.value))}
                className="field w-24"
              />
            </label>
          )}
        </div>
      </div>

      <label className="mt-3 block">
        <div className="mb-1 text-xs text-[var(--muted)]">Input to run with</div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder="The same input you'd type when running the skill by hand…"
          className="field resize-y"
        />
      </label>

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <input
            type="checkbox"
            checked={retrieve}
            onChange={(e) => setRetrieve(e.target.checked)}
            className="accent-[var(--brand)]"
          />
          Use knowledge base (RAG)
        </label>
        <button onClick={create} disabled={busy || !input.trim()} className="btn-brand">
          {busy ? "Scheduling…" : "Schedule it"}
        </button>
      </div>
      <p className="mono mt-2 text-[0.7rem] text-[var(--muted)]">
        Times use the server&apos;s local timezone.
      </p>
    </div>
  );
}

function ScheduleRow({
  slug,
  sched,
  onDone,
}: {
  slug: string;
  sched: SkillSchedule;
  onDone: (out: { schedules: SkillSchedule[] } | { error: string }) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    onDone(await toggleScheduleAction(slug, sched.id, !sched.enabled));
    setBusy(false);
  }
  async function del() {
    if (!confirm("Delete this schedule?")) return;
    setBusy(true);
    onDone(await deleteScheduleAction(slug, sched.id));
    setBusy(false);
  }

  return (
    <div className={`inset flex items-center justify-between gap-4 p-3 ${sched.enabled ? "" : "opacity-60"}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[var(--text)]">{describe(sched)}</span>
          {sched.retrieve && (
            <span className="rounded bg-[var(--brand-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--brand-ink)]">
              RAG
            </span>
          )}
        </div>
        <div className="mono mt-1 truncate text-xs text-[var(--muted)]">
          {sched.enabled ? `next ${fmtWhen(sched.nextRunAt)}` : "paused"}
          {sched.lastRunAt && ` · last ${fmtWhen(sched.lastRunAt)} (${sched.lastStatus ?? "?"})`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button
          onClick={toggle}
          disabled={busy}
          className="text-xs text-[var(--muted)] transition hover:text-[var(--text)] disabled:opacity-40"
        >
          {sched.enabled ? "Pause" : "Resume"}
        </button>
        <button
          onClick={del}
          disabled={busy}
          className="text-xs text-[var(--muted)] transition hover:text-[var(--danger)] disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
