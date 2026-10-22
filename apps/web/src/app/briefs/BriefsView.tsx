"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Brief, Schedule } from "@ai-hub/db";
import { Markdown } from "@/components/Markdown";
import { cadence, money } from "@/lib/format";
import { runBriefNowAction, setMorningBriefAction } from "./actions";

export interface BriefSkillCard {
  id: string;
  slug: string;
  name: string;
  description: string;
  agentName: string;
  agentSlug: string;
  /** Every required argument can be answered without a person. */
  schedulable: boolean;
  /** The viewer's own schedule for it, if any (on or off). */
  mine: Schedule | null;
  /** How many other people have it on their morning clock. */
  others: number;
}

// A time of day as the schedule stores it: minutes past local midnight.
const TIMES = [6 * 60, 6 * 60 + 30, 7 * 60, 7 * 60 + 30, 8 * 60, 8 * 60 + 30, 9 * 60];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function BriefsView({
  briefs,
  skills,
  timezone,
  viewerId,
}: {
  briefs: Brief[];
  skills: BriefSkillCard[];
  timezone: string;
  viewerId: string;
}) {
  const router = useRouter();
  const running = briefs.some((b) => b.status === "running");

  // A brief takes minutes to write. While one is being written, the page
  // re-reads itself every ten seconds so the reader is not left pressing
  // refresh; nothing is polled once everything has finished.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [running, router]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="flex min-w-0 flex-col gap-5">
        {briefs.length === 0 ? (
          <div className="panel p-6">
            <div className="eyebrow">No briefs yet</div>
            <p className="mt-2 max-w-xl text-sm text-[var(--text-soft)]">
              {skills.length
                ? "Run one now from the right, or put it on your morning clock and it will be here when you arrive."
                : "No agent has a brief skill yet. Mark a skill as “a brief” on its agent’s page and it appears here."}
            </p>
          </div>
        ) : (
          briefs.map((b) => <BriefCard key={b.id} brief={b} viewerId={viewerId} />)
        )}
      </section>

      <aside className="flex flex-col gap-4">
        {skills.map((s) => (
          <SkillCard key={s.id} skill={s} timezone={timezone} />
        ))}
        {skills.length > 0 && (
          <p className="px-1 text-xs text-[var(--muted)]">
            A scheduled brief runs as the person who switched it on, reads what they may read, and stops if they are
            disabled. Times are in {timezone}.
          </p>
        )}
      </aside>
    </div>
  );
}

function BriefCard({ brief: b, viewerId }: { brief: Brief; viewerId: string }) {
  const when = b.startedAt ? new Date(b.startedAt) : null;
  const day = when ? when.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "";
  const time = when ? when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  const by = b.principalId === viewerId ? "you" : b.principalName || b.principalId || "a schedule";
  return (
    <article className="panel p-5 md:p-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <div className="eyebrow">{day}</div>
          <h2 className="mt-1 text-lg">
            {b.skillName}
            <span className="font-normal text-[var(--muted)]"> · {b.agentName}</span>
          </h2>
        </div>
        <div className="mono text-xs text-[var(--muted)]">
          {time} · for {by}
          {b.costUsd !== null && b.status === "succeeded" ? ` · ${money(b.costUsd)}` : ""}
        </div>
      </header>

      {b.status === "running" && (
        <p className="flex items-center gap-2 text-sm text-[var(--muted)]" role="status">
          <span aria-hidden className="ctx-blink inline-block h-2 w-2 bg-[var(--ai)]" />
          {b.agentName} is writing this brief…
        </p>
      )}
      {b.status === "failed" && (
        <div role="alert" className="notice-danger border border-[var(--danger)] p-3 text-sm text-[var(--danger)]">
          This brief failed: {b.error ?? "no reason was recorded."}
        </div>
      )}
      {b.status === "succeeded" &&
        (b.output?.trim() ? (
          <Markdown className="border-l-2 border-[var(--ai)] pl-4">{b.output}</Markdown>
        ) : (
          <p className="text-sm text-[var(--muted)]">The run finished without writing anything.</p>
        ))}
    </article>
  );
}

function SkillCard({ skill: s, timezone }: { skill: BriefSkillCard; timezone: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [atMinute, setAtMinute] = useState<number>(s.mine?.atMinute ?? 7 * 60);
  const [weekends, setWeekends] = useState<boolean>(s.mine ? s.mine.weekdays.length === 0 : false);
  const on = Boolean(s.mine?.enabled);

  function runNow() {
    setMessage(null);
    start(async () => {
      const res = await runBriefNowAction(s.id);
      if ("error" in res) setMessage({ text: res.error, error: true });
      else {
        setMessage({ text: res.status === "running" ? "Started. It will appear on the left as it is written." : "Done.", error: false });
        router.refresh();
      }
    });
  }

  function toggle(next: boolean) {
    setMessage(null);
    start(async () => {
      const res = await setMorningBriefAction({ skillRef: s.id, on: next, atMinute, weekends });
      if ("error" in res) setMessage({ text: res.error, error: true });
      else router.refresh();
    });
  }

  return (
    <div className="panel p-5">
      <div className="eyebrow">{s.agentName}</div>
      <h3 className="mt-1 text-base">{s.name}</h3>
      {s.description && <p className="mt-1 text-sm text-[var(--text-soft)]">{s.description}</p>}

      <button type="button" className="btn-brand mt-4 min-h-11 w-full" onClick={runNow} disabled={pending || !s.schedulable}>
        {pending ? "Working…" : "Run now, for today"}
      </button>

      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[var(--text)]"
            checked={on}
            disabled={pending || !s.schedulable}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Every morning, for me</span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">
              {on && s.mine
                ? `${cadence(s.mine)} · ${timezone}`
                : "Written before you arrive, as you, from what you may read."}
            </span>
          </span>
        </label>

        {!on && s.schedulable && (
          <div className="mt-3 flex flex-wrap items-center gap-3 pl-7 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-xs text-[var(--muted)]">At</span>
              <select className="field mono py-1" value={atMinute} onChange={(e) => setAtMinute(Number(e.target.value))}>
                {TIMES.map((t) => (
                  <option key={t} value={t}>
                    {hhmm(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <input type="checkbox" className="h-4 w-4 accent-[var(--text)]" checked={weekends} onChange={(e) => setWeekends(e.target.checked)} />
              weekends too
            </label>
          </div>
        )}
        {on && (
          <p className="mt-2 pl-7 text-xs text-[var(--muted)]">To change the time, switch it off and on again.</p>
        )}
        {s.others > 0 && (
          <p className="mt-2 pl-7 text-xs text-[var(--muted)]">
            {s.others === 1 ? "One other person has" : `${s.others} other people have`} this on their morning clock.
          </p>
        )}
        {!s.schedulable && (
          <p className="mt-2 text-xs text-[var(--warning)]">
            This brief needs arguments a clock cannot supply. Ask for it from{" "}
            <Link href={`/agents/${s.agentSlug}`} className="underline underline-offset-2">
              {s.agentName}&apos;s page
            </Link>{" "}
            or Claude Code.
          </p>
        )}
      </div>

      {message && (
        <p role={message.error ? "alert" : "status"} className={`mt-3 text-sm ${message.error ? "text-[var(--danger)]" : "text-[var(--ai)]"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
