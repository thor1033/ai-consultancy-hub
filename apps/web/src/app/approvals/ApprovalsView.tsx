"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Proposal } from "@ai-hub/db";
import { rel } from "@/lib/format";
import { approveProposalsAction, rejectProposalsAction, sendProposalsAction, type Outcome } from "./actions";
import { present } from "./present";

/*
 * The approvals desk.
 *
 * Built around how the writes arrive: in batches, one batch per agent run (a
 * meeting follow-up proposes sixteen at once). So a run is a card, its
 * writes are rows, and every action exists at three sizes — one row, one
 * run, or whatever is selected across runs. Each row leads with the agent's
 * reason, then what changes in words, and keeps the exact call one click away:
 * what is approved is always what runs.
 *
 * Colour follows the system: black is the person's, red is what needs an
 * action, blue is what the agent did. Circles are people.
 */

type Person = { id: string; name: string; email: string };
type Viewer = { id: string; admin: boolean };
type Tab = "mine" | "sent" | "decided";

interface Props {
  pending: Proposal[];
  decided: Proposal[];
  people: Person[];
  viewer: Viewer;
  now: number;
}

export function ApprovalsView({ pending, decided, people, viewer, now }: Props) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const mine = useMemo(() => pending.filter((p) => !p.assignedTo || p.assignedTo === viewer.id), [pending, viewer.id]);
  const sent = useMemo(() => pending.filter((p) => p.assignedTo && p.assignedTo !== viewer.id), [pending, viewer.id]);
  const sentToMe = mine.filter((p) => p.assignedTo === viewer.id).length;
  const [tab, setTab] = useState<Tab>("mine");

  const week = now - 7 * 864e5;
  const recent = decided.filter((p) => Date.parse(p.decidedAt ?? p.createdAt) >= week);
  const ranThisWeek = recent.filter((p) => p.status === "executed").length;
  const failedThisWeek = recent.filter((p) => p.status === "failed").length;

  const nameOf = (id: string | null) => {
    if (!id) return "someone";
    if (id === viewer.id) return "you";
    return people.find((p) => p.id === id)?.name ?? id;
  };

  /** Run a batch action, report it in words, refresh the lists. */
  function run(label: string, ids: string[], fn: () => Promise<Outcome[] | { error: string }>) {
    setFlash(null);
    start(async () => {
      const res = await fn();
      if ("error" in res) {
        setFlash({ tone: "bad", text: res.error });
        return;
      }
      const ok = res.filter((r): r is Extract<Outcome, { proposal: Proposal }> => "proposal" in r);
      const failedRuns = ok.filter((r) => r.proposal.status === "failed").length;
      const refused = res.filter((r): r is Extract<Outcome, { error: string }> => "error" in r);
      const parts = [`${label} ${ok.length} of ${ids.length}.`];
      if (failedRuns) parts.push(`${failedRuns} ran and failed; the error is on the row under Decided.`);
      if (refused.length) parts.push(`${refused.length} could not be: ${refused[0].error}`);
      setFlash({ tone: failedRuns || refused.length ? "bad" : "ok", text: parts.join(" ") });
      setSelected((s) => {
        const next = new Set(s);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      router.refresh();
    });
  }

  const actions: Actions = {
    approve: (ids) => run("Approved", ids, () => approveProposalsAction(ids)),
    reject: (ids, note) => run("Rejected", ids, () => rejectProposalsAction(ids, note)),
    send: (ids, to, note) => run(to ? `Sent to ${nameOf(to)}:` : "Took back", ids, () => sendProposalsAction(ids, to, note)),
    busy,
  };

  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  const headline =
    mine.length === 0 ? "Nothing waiting for you" : `${mine.length} ${mine.length === 1 ? "write" : "writes"} waiting for you`;

  return (
    <>
      {/* ── the page's one sentence ─────────────────────────────────────── */}
      <header className="fade-in">
        <div className="eyebrow">Approvals</div>
        <h1 className="mt-3 max-w-3xl text-3xl leading-[1.05] tracking-[-0.02em] md:text-[2.75rem]">{headline}</h1>
        <p className="mt-3 max-w-2xl text-sm text-[var(--muted)]">
          Agents propose; nothing changes until a person says yes. Approving runs the exact call shown — no more, no less.
          {sentToMe > 0 && (
            <>
              {" "}
              <span className="text-[var(--text)]">
                {sentToMe} {sentToMe === 1 ? "was" : "were"} sent to you by a colleague.
              </span>
            </>
          )}
        </p>
      </header>

      <dl className="mt-7 grid grid-cols-2 border-y border-[var(--border-strong)] md:grid-cols-4">
        <Stat label="Waiting on you" value={mine.length} accent={mine.length > 0} />
        <Stat label="With colleagues" value={sent.length} />
        <Stat label="Ran · 7 days" value={ranThisWeek} />
        <Stat label="Failed · 7 days" value={failedThisWeek} danger={failedThisWeek > 0} />
      </dl>

      {/* ── tabs ─────────────────────────────────────────────────────────── */}
      <div role="tablist" aria-label="Approvals" className="mt-8 flex gap-1 overflow-x-auto border-b border-[var(--border-strong)]">
        <TabButton id="mine" open={tab} onPick={setTab} label="Waiting on you" count={mine.length} />
        <TabButton id="sent" open={tab} onPick={setTab} label="Sent on" count={sent.length} />
        <TabButton id="decided" open={tab} onPick={setTab} label="Decided" count={decided.length} />
      </div>

      <div aria-live="polite">
        {flash && (
          <div className={`mt-5 flex items-start justify-between gap-4 p-3 text-sm ${flash.tone === "ok" ? "notice-info" : "notice-warning"}`}>
            <span>{flash.text}</span>
            <button type="button" className="text-xs text-[var(--muted)] hover:text-[var(--brand)]" onClick={() => setFlash(null)}>
              Dismiss
            </button>
          </div>
        )}
      </div>

      <section role="tabpanel" className="pt-6">
        {tab === "mine" &&
          (mine.length === 0 ? (
            <Empty
              title="You are clear."
              body="When an agent reaches for a tool that writes — a task, a note, a file — the call lands here instead of happening, with the agent's reason. Writes a colleague sends you appear here too."
            />
          ) : (
            <RunList proposals={mine} viewer={viewer} people={people} now={now} selected={selected} toggle={toggle} actions={actions} nameOf={nameOf} />
          ))}
        {tab === "sent" &&
          (sent.length === 0 ? (
            <Empty
              title="Nothing is with a colleague."
              body="Send a write to someone else to decide with the Send button on a row or a run. You can still decide it yourself afterwards, or take it back."
            />
          ) : (
            <RunList proposals={sent} viewer={viewer} people={people} now={now} selected={selected} toggle={toggle} actions={actions} nameOf={nameOf} sentView />
          ))}
        {tab === "decided" &&
          (decided.length === 0 ? (
            <Empty title="Nothing decided yet." body="Approved, rejected and failed writes are kept here, with what each call returned." />
          ) : (
            <DecidedList proposals={decided} now={now} nameOf={nameOf} />
          ))}
      </section>

      {/* ── the selection bar ───────────────────────────────────────────── */}
      {tab !== "decided" && selected.size > 0 && (
        <SelectionBar ids={[...selected]} people={people} actions={actions} clear={() => setSelected(new Set())} />
      )}
    </>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

interface Actions {
  approve: (ids: string[]) => void;
  reject: (ids: string[], note: string) => void;
  send: (ids: string[], to: string | null, note: string) => void;
  busy: boolean;
}

function Stat({ label, value, accent = false, danger = false }: { label: string; value: number; accent?: boolean; danger?: boolean }) {
  return (
    <div className="border-[var(--border)] px-4 py-4 odd:border-r md:border-r md:last:border-r-0 [&:nth-child(-n+2)]:border-b md:[&:nth-child(-n+2)]:border-b-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="metric mt-2 text-3xl font-medium" style={{ color: danger ? "var(--danger)" : accent ? "var(--brand)" : "var(--text)" }}>
        {value}
      </dd>
    </div>
  );
}

function TabButton({ id, open, onPick, label, count }: { id: Tab; open: Tab; onPick: (t: Tab) => void; label: string; count: number }) {
  const active = id === open;
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => onPick(id)}
      className={`-mb-px flex min-h-11 shrink-0 items-center gap-2 border-b-[3px] px-3 text-sm font-medium transition-colors ${
        active ? "border-[var(--brand)] text-[var(--text)]" : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
      }`}
    >
      {label}
      <span className={`mono text-xs ${active ? "text-[var(--brand)]" : "text-[var(--faint)]"}`}>{count}</span>
    </button>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rule-heavy fade-in max-w-2xl pt-6">
      <p className="text-2xl tracking-[-0.01em]">{title}</p>
      <p className="mt-2 text-sm text-[var(--muted)]">{body}</p>
    </div>
  );
}

/** Initials in a circle — the brand's sign for a person. */
function PersonMark({ name, size = 28, active = false }: { name: string; size?: number; active?: boolean }) {
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full border text-[0.68rem] font-medium"
      style={{
        width: size,
        height: size,
        borderColor: "var(--text)",
        background: active ? "var(--text)" : "transparent",
        color: active ? "var(--bg)" : "var(--text)",
      }}
    >
      {initials}
    </span>
  );
}

// ── runs ─────────────────────────────────────────────────────────────────────

interface RunGroup {
  key: string;
  agentName: string | null;
  agentSlug: string | null;
  title: string;
  at: string;
  items: Proposal[];
}

/** The run's first meaningful line, as a title. Skill prompts open with what they were asked to do. */
function runTitle(p: Proposal): string {
  const line = (p.runPrompt ?? "")
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").trim())
    .find((l) => l.length > 3);
  if (!line) return p.agentName ? `Writes from ${p.agentName}` : "Writes from a workbench session";
  return line.length > 110 ? `${line.slice(0, 107)}…` : line;
}

function groupRuns(proposals: Proposal[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  for (const p of proposals) {
    const key = p.runId ?? `single-${p.id}`;
    const g = groups.get(key);
    if (g) g.items.push(p);
    else groups.set(key, { key, agentName: p.agentName, agentSlug: p.agentSlug, title: runTitle(p), at: p.runAt ?? p.createdAt, items: [p] });
  }
  for (const g of groups.values()) g.items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return [...groups.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

interface ListProps {
  proposals: Proposal[];
  viewer: Viewer;
  people: Person[];
  now: number;
  selected: Set<string>;
  toggle: (ids: string[], on: boolean) => void;
  actions: Actions;
  nameOf: (id: string | null) => string;
  sentView?: boolean;
}

function RunList(props: ListProps) {
  const groups = groupRuns(props.proposals);
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g, i) => (
        <RunCard key={g.key} group={g} {...props} delay={i} />
      ))}
    </div>
  );
}

type Panel = { kind: "approve" | "reject" | "send"; ids: string[] } | null;

function RunCard({ group, people, now, selected, toggle, actions, nameOf, sentView, delay }: ListProps & { group: RunGroup; delay: number }) {
  const [panel, setPanel] = useState<Panel>(null);
  const live = group.items.filter((p) => p.status === "pending");
  const ids = live.map((p) => p.id);
  const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
  const someOn = ids.some((id) => selected.has(id));
  const first = group.items[0];
  const allHanded = Boolean(first.assignedTo) && group.items.every((p) => p.assignedTo === first.assignedTo);

  return (
    <article className="panel fade-in shadow-[var(--shadow-soft)]" style={{ animationDelay: `${Math.min(delay, 6) * 40}ms` }}>
      {/* the run */}
      <header className="flex flex-wrap items-start gap-x-5 gap-y-3 px-5 pb-4 pt-5">
        <label className="mt-1.5 flex items-center" title={allOn ? "Clear this run" : "Select this run"}>
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--text)]"
            checked={allOn}
            ref={(el) => {
              if (el) el.indeterminate = someOn && !allOn;
            }}
            disabled={ids.length === 0}
            onChange={(e) => toggle(ids, e.target.checked)}
            aria-label={`Select all ${ids.length} in this run`}
          />
        </label>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)]">
            <span className="dot bg-[var(--ai)]" aria-hidden />
            {group.agentSlug ? (
              <Link href={`/agents/${group.agentSlug}`} className="eyebrow !text-[var(--ai)] hover:!text-[var(--brand)]">
                {group.agentName}
              </Link>
            ) : (
              <span className="eyebrow">Workbench</span>
            )}
            <span aria-hidden>·</span>
            <span>{rel(group.at, now).toLowerCase()}</span>
            <span aria-hidden>·</span>
            <span>
              {group.items.length} {group.items.length === 1 ? "write" : "writes"}
            </span>
          </div>
          <h2 className="mt-2 text-lg font-medium leading-snug">{group.title}</h2>
        </div>
        {ids.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-brand min-h-9" disabled={actions.busy} onClick={() => setPanel({ kind: "approve", ids })}>
              Approve all {ids.length}
            </button>
            <button type="button" className="btn min-h-9" disabled={actions.busy} onClick={() => setPanel({ kind: "send", ids })}>
              {sentView ? "Send all elsewhere" : "Send all to…"}
            </button>
            <button type="button" className="btn min-h-9" disabled={actions.busy} onClick={() => setPanel({ kind: "reject", ids })}>
              Reject all
            </button>
          </div>
        )}
      </header>

      {allHanded && <HandoffNote by={nameOf(first.assignedBy)} to={nameOf(first.assignedTo)} note={first.assignNote} at={first.assignedAt} now={now} />}

      {panel && (
        <div className="border-t border-[var(--border)] bg-[var(--panel-inset)] px-5 py-4">
          <ActionPanel panel={panel} people={people} actions={actions} close={() => setPanel(null)} />
        </div>
      )}

      <ol className="border-t border-[var(--border)]">
        {group.items.map((p, i) => (
          <Row
            key={p.id}
            p={p}
            index={i + 1}
            people={people}
            now={now}
            checked={selected.has(p.id)}
            onCheck={(on) => toggle([p.id], on)}
            actions={actions}
            nameOf={nameOf}
            showHandoff={!allHanded}
            sentView={sentView}
          />
        ))}
      </ol>
    </article>
  );
}

function HandoffNote({ by, to, note, at, now }: { by: string; to: string; note: string | null; at: string | null; now: number }) {
  return (
    <div className="flex items-start gap-3 border-t border-[var(--border)] bg-[var(--panel-inset)] px-5 py-3 text-sm">
      <PersonMark name={by === "you" ? "You" : by} size={24} />
      <p className="min-w-0 pt-0.5">
        <span className="text-[var(--muted)]">
          {by === "you" ? "You sent this" : `${by} sent this`} to {to}
          {at && ` · ${rel(at, now).toLowerCase()}`}
        </span>
        {note && <span className="text-[var(--text)]"> — “{note}”</span>}
      </p>
    </div>
  );
}

// ── one write ────────────────────────────────────────────────────────────────

function Row({
  p,
  index,
  people,
  now,
  checked,
  onCheck,
  actions,
  nameOf,
  showHandoff,
  sentView,
}: {
  p: Proposal;
  index: number;
  people: Person[];
  now: number;
  checked: boolean;
  onCheck: (on: boolean) => void;
  actions: Actions;
  nameOf: (id: string | null) => string;
  showHandoff: boolean;
  sentView?: boolean;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [open, setOpen] = useState(false);
  const shown = present(p.tool, p.args ?? {});
  const short = shown.changes.filter((c) => !c.long);
  const long = shown.changes.filter((c) => c.long);
  const running = p.status === "approved";

  return (
    <li className="border-b border-[var(--border)] last:border-b-0">
      <div className="grid grid-cols-[auto_1fr] gap-x-5 px-5 py-4 md:grid-cols-[auto_1fr_auto]">
        <label className="mt-1 flex items-start">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--text)]"
            checked={checked}
            disabled={p.status !== "pending"}
            onChange={(e) => onCheck(e.target.checked)}
            aria-label={`Select: ${shown.verb} ${shown.headline ?? ""}`}
          />
        </label>

        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="mono text-[0.7rem] text-[var(--faint)]">{String(index).padStart(2, "0")}</span>
            <span className="border border-[var(--border-strong)] px-1.5 py-[1px] text-[0.66rem] font-medium uppercase tracking-[0.14em] text-[var(--text-soft)]">
              {shown.verb}
            </span>
            {shown.headline && <span className="min-w-0 font-medium">{shown.headline}</span>}
            {shown.ref && <span className="mono text-[0.72rem] text-[var(--faint)]">{shown.ref}</span>}
            {running && <span className="text-xs text-[var(--ai)]">Running…</span>}
          </div>

          {p.reason ? (
            <p className="mt-2 max-w-[68ch] text-[0.95rem] leading-relaxed text-[var(--text-soft)]">{p.reason}</p>
          ) : (
            <p className="mt-2 text-sm text-[var(--faint)]">No reason given — judge it from the call below, or reject it and ask.</p>
          )}

          {short.length > 0 && (
            <dl className="mt-3 flex flex-wrap gap-2">
              {short.map((c) => (
                <div key={c.field} className="flex items-baseline gap-1.5 bg-[var(--panel-inset)] px-2 py-1 text-[0.8rem]">
                  <dt className="text-[var(--muted)]">{c.field}</dt>
                  <span aria-hidden className="text-[var(--faint)]">
                    →
                  </span>
                  <dd className="font-medium">{c.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {showHandoff && p.assignedTo && (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
              <PersonMark name={sentView ? nameOf(p.assignedTo) : nameOf(p.assignedBy) === "you" ? "You" : nameOf(p.assignedBy)} size={20} />
              {sentView ? `With ${nameOf(p.assignedTo)}` : `Sent to you by ${nameOf(p.assignedBy)}`}
              {p.assignedAt && ` · ${rel(p.assignedAt, now).toLowerCase()}`}
              {p.assignNote && <span className="text-[var(--text-soft)]">— “{p.assignNote}”</span>}
            </p>
          )}

          <button
            type="button"
            className="mt-3 text-xs text-[var(--muted)] underline-offset-2 hover:text-[var(--brand)] hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide the exact call" : long.length ? `Show the exact call and the ${long.map((c) => c.field.toLowerCase()).join(", ")}` : "Show the exact call"}
          </button>
          {open && <ExactCall p={p} long={long} />}
        </div>

        {p.status === "pending" && (
          // One solid button per row; the rest are quiet. Sixteen rows of three
          // equal buttons made the buttons the page, not the reasons.
          <div className="col-span-2 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 md:col-span-1 md:mt-0 md:flex-col md:items-end">
            <button type="button" className="btn-brand min-h-9 px-5 md:min-w-[8rem]" disabled={actions.busy} onClick={() => actions.approve([p.id])}>
              Approve
            </button>
            <div className="flex items-center gap-4 text-sm">
              <QuietButton active={panel?.kind === "send"} disabled={actions.busy} onClick={() => setPanel(panel?.kind === "send" ? null : { kind: "send", ids: [p.id] })}>
                {sentView ? "Send elsewhere" : "Send to…"}
              </QuietButton>
              <QuietButton active={panel?.kind === "reject"} disabled={actions.busy} onClick={() => setPanel(panel?.kind === "reject" ? null : { kind: "reject", ids: [p.id] })}>
                Reject
              </QuietButton>
            </div>
            {sentView && (
              <QuietButton disabled={actions.busy} onClick={() => actions.send([p.id], null, "")}>
                Take back
              </QuietButton>
            )}
          </div>
        )}
      </div>

      {panel && (
        <div className="border-t border-[var(--border)] bg-[var(--panel-inset)] px-5 py-4 md:pl-14">
          <ActionPanel panel={panel} people={people} actions={actions} close={() => setPanel(null)} />
        </div>
      )}
    </li>
  );
}

/** A text button: ink that turns red, underlined while its panel is open. */
function QuietButton({ active = false, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={`min-h-8 text-sm underline-offset-4 transition-colors hover:text-[var(--brand)] hover:underline disabled:opacity-40 ${
        active ? "text-[var(--brand)] underline" : "text-[var(--text-soft)]"
      }`}
    >
      {children}
    </button>
  );
}

function ExactCall({ p, long }: { p: Proposal; long: { field: string; value: string }[] }) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      {long.map((c) => (
        <div key={c.field} className="inset p-3">
          <div className="eyebrow mb-1.5">{c.field}</div>
          <p className="max-h-72 overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-soft)]">{c.value}</p>
        </div>
      ))}
      <div className="inset p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="mono text-xs">
            {p.tool} <span className="text-[var(--muted)]">on {p.server}</span>
          </span>
          <span className="eyebrow">Runs exactly this</span>
        </div>
        <pre className="mono mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-[0.75rem] leading-relaxed text-[var(--text-soft)]">
          {JSON.stringify(p.args, null, 2)}
        </pre>
        {p.description && <p className="mt-2 text-xs text-[var(--muted)]">{p.description}</p>}
      </div>
    </div>
  );
}

// ── deciding ─────────────────────────────────────────────────────────────────

function ActionPanel({ panel, people, actions, close }: { panel: NonNullable<Panel>; people: Person[]; actions: Actions; close: () => void }) {
  const [note, setNote] = useState("");
  const [to, setTo] = useState<string | null>(people.length === 1 ? people[0].id : null);
  const n = panel.ids.length;
  const them = n === 1 ? "it" : `all ${n}`;

  if (panel.kind === "approve") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm">
          <span className="font-medium">Run {them} now?</span>{" "}
          <span className="text-[var(--muted)]">Each call runs in turn, exactly as shown. A failure is recorded on its row and the rest still run.</span>
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-brand min-h-9"
            disabled={actions.busy}
            onClick={() => {
              actions.approve(panel.ids);
              close();
            }}
          >
            Approve and run {n === 1 ? "it" : n}
          </button>
          <button type="button" className="btn min-h-9" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (panel.kind === "reject") {
    return (
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          actions.reject(panel.ids, note);
          close();
        }}
      >
        <label className="min-w-[16rem] flex-1">
          <span className="eyebrow mb-1.5 block">Why not{n > 1 ? ` — recorded on all ${n}` : ""}</span>
          <input className="field" autoFocus placeholder="Optional, and worth it: the agent's next run can read it" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="btn-brand min-h-9" disabled={actions.busy}>
            Reject {n === 1 ? "it" : n}
          </button>
          <button type="button" className="btn min-h-9" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  // send
  if (people.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-[var(--muted)]">
          No one else can decide writes yet. A colleague needs to have signed in once, with a role that runs agents (analyst or admin) — set on{" "}
          <Link href="/admin" className="underline underline-offset-2 hover:text-[var(--brand)]">
            Admin
          </Link>
          .
        </p>
        <button type="button" className="btn min-h-9" onClick={close}>
          Close
        </button>
      </div>
    );
  }
  const target = people.find((p) => p.id === to);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!to) return;
        actions.send(panel.ids, to, note);
        close();
      }}
    >
      <fieldset>
        <legend className="eyebrow mb-2">Send {n === 1 ? "this write" : `${n} writes`} to</legend>
        <div className="flex flex-wrap gap-2">
          {people.map((person) => {
            const on = person.id === to;
            return (
              <label
                key={person.id}
                className={`flex cursor-pointer items-center gap-2.5 border px-3 py-2 text-sm transition-colors focus-within:border-[var(--ai)] ${
                  on ? "border-[var(--text)] bg-[var(--panel)]" : "border-[var(--border-strong)] hover:border-[var(--brand)]"
                }`}
              >
                <input type="radio" name="to" className="sr-only" checked={on} onChange={() => setTo(person.id)} />
                <PersonMark name={person.name} active={on} />
                <span className="flex flex-col leading-tight">
                  <span className="font-medium">{person.name}</span>
                  <span className="text-xs text-[var(--muted)]">{person.email}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <label>
        <span className="eyebrow mb-1.5 block">A note for them</span>
        <input className="field" placeholder="e.g. “Your call — these are the commercial tasks from Saturday.”" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn-brand min-h-9" disabled={!to || actions.busy}>
          {target ? `Send to ${target.name.split(" ")[0]}` : "Choose a person"}
        </button>
        <button type="button" className="btn min-h-9" onClick={close}>
          Cancel
        </button>
        <span className="text-xs text-[var(--muted)]">They see it under “Waiting on you”. You can still decide it, or take it back.</span>
      </div>
    </form>
  );
}

function SelectionBar({ ids, people, actions, clear }: { ids: string[]; people: Person[]; actions: Actions; clear: () => void }) {
  const [panel, setPanel] = useState<Panel>(null);
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 lg:left-[15rem]" role="region" aria-label="Selected writes">
      {panel && (
        <div className="mx-auto max-w-[80rem] px-5 lg:px-8">
          <div className="border border-b-0 border-[var(--border-strong)] bg-[var(--panel)] px-5 py-4 shadow-[var(--shadow-popover)]">
            <ActionPanel panel={panel} people={people} actions={actions} close={() => setPanel(null)} />
          </div>
        </div>
      )}
      <div className="bg-[var(--text)] text-[var(--bg)]">
        <div className="mx-auto flex max-w-[80rem] flex-wrap items-center gap-3 px-5 py-3 lg:px-8">
          <span className="text-sm">
            <span className="metric text-lg font-medium">{ids.length}</span> selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <BarButton strong disabled={actions.busy} onClick={() => setPanel({ kind: "approve", ids })}>
              Approve {ids.length}
            </BarButton>
            <BarButton disabled={actions.busy} onClick={() => setPanel({ kind: "send", ids })}>
              Send to…
            </BarButton>
            <BarButton disabled={actions.busy} onClick={() => setPanel({ kind: "reject", ids })}>
              Reject
            </BarButton>
            <button
              type="button"
              className="px-2 text-xs opacity-70 hover:opacity-100"
              onClick={() => {
                setPanel(null);
                clear();
              }}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A button on the inverse bar: paper on black, red on hover — the system's swap, inverted. */
function BarButton({ strong = false, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { strong?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex min-h-9 items-center px-3.5 text-sm font-medium transition-colors disabled:opacity-40 ${
        strong
          ? "bg-[var(--bg)] text-[var(--text)] hover:bg-[var(--brand)] hover:text-[var(--tk-paper)]"
          : "border border-[color-mix(in_srgb,var(--bg)_40%,transparent)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
      }`}
    >
      {children}
    </button>
  );
}

// ── decided ──────────────────────────────────────────────────────────────────

const OUTCOME: Record<string, { label: string; color: string }> = {
  executed: { label: "Ran", color: "var(--text)" },
  failed: { label: "Failed", color: "var(--danger)" },
  rejected: { label: "Rejected", color: "var(--faint)" },
};

function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, new Date(now))) return "Today";
  if (same(d, new Date(now - 864e5))) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function DecidedList({ proposals, now, nameOf }: { proposals: Proposal[]; now: number; nameOf: (id: string | null) => string }) {
  const days = new Map<string, Proposal[]>();
  for (const p of proposals) {
    const key = dayLabel(p.decidedAt ?? p.createdAt, now);
    days.set(key, [...(days.get(key) ?? []), p]);
  }
  return (
    <div className="flex flex-col gap-8">
      {[...days].map(([day, items]) => (
        <section key={day}>
          <h2 className="eyebrow mb-2">{day}</h2>
          <ol className="panel">
            {items.map((p) => (
              <DecidedRow key={p.id} p={p} now={now} nameOf={nameOf} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function DecidedRow({ p, now, nameOf }: { p: Proposal; now: number; nameOf: (id: string | null) => string }) {
  const [open, setOpen] = useState(false);
  const shown = present(p.tool, p.args ?? {});
  const o = OUTCOME[p.status] ?? { label: p.status, color: "var(--muted)" };
  return (
    <li className="border-b border-[var(--border)] last:border-b-0">
      <button
        type="button"
        className="flex w-full items-start gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--panel-inset)]"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
      >
        <span className="dot mt-1.5 shrink-0" style={{ background: o.color }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[0.66rem] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">{shown.verb}</span>
            <span className={`font-medium ${p.status === "rejected" ? "text-[var(--muted)] line-through decoration-[var(--faint)]" : ""}`}>
              {shown.headline ?? p.tool}
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-[var(--muted)]">
            <span style={{ color: o.color }}>{o.label}</span>
            {p.decidedBy && ` · ${p.status === "rejected" ? "rejected" : "approved"} by ${nameOf(p.decidedBy)}`}
            {p.agentName && ` · proposed by ${p.agentName}`}
            {p.decidedAt && ` · ${rel(p.decidedAt, now).toLowerCase()}`}
          </span>
          {p.status === "rejected" && p.note && <span className="mt-1 block text-sm text-[var(--text-soft)]">“{p.note}”</span>}
          {p.status === "failed" && p.error && <span className="mt-1 block text-sm text-[var(--danger)]">{p.error}</span>}
        </span>
        <span className="text-xs text-[var(--faint)]">{open ? "Less" : "More"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pl-10">
          {p.reason && <p className="mb-3 max-w-[68ch] text-sm text-[var(--text-soft)]">{p.reason}</p>}
          <ExactCall p={p} long={[]} />
          {p.status === "executed" && p.result && (
            <div className="inset mt-3 p-3">
              <div className="eyebrow mb-1.5">What the tool returned</div>
              <pre className="mono max-h-64 overflow-auto whitespace-pre-wrap text-[0.75rem]">{p.result.length > 4000 ? `${p.result.slice(0, 4000)}…` : p.result}</pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
