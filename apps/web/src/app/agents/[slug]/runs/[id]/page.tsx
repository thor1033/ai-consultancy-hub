import { notFound } from "next/navigation";
import Link from "next/link";
import { getAgent, getRunTiming, getRunTranscript, listChildRuns, retentionPolicy, type RunTranscript } from "@ai-hub/db";
import type { RunTimeline, TurnTiming } from "@ai-hub/agent";
import { money } from "@/lib/format";
import { sessionCan, sessionPrincipal } from "@/lib/sessionPrincipal";
import { viewContext } from "@/lib/viewServer";
import { PART_STYLE, count, duration, isTimeline, readTimeline, type Part } from "@/lib/runTiming";
import { hiddenPromptLabel, privateRun } from "@/lib/runPrivacy";
import { SaveCaseButton } from "../../SaveCaseButton";

export const dynamic = "force-dynamic";

// One run: where its time went. Visible to whoever can see the run in the
// agent's list, because it shows no more than that list does — the prompt's
// first line, numbers, and tool names.
//
// What was said — the transcript — is the exception, and a narrow one
// (docs/effective-agents-review.md, E2): every Anthropic post on agents ends
// with "read the transcripts", and the hub stored them and let nobody look.
// It is shown to the run's own person and to admins, in the Expert view,
// while retention keeps it (docs/retention.md), as stored — masked, and empty
// for a run that touched special-category material (docs/sensitivity.md).

export default async function RunPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const agent = await getAgent(slug);
  if (!agent) notFound();
  const found = await getRunTiming(id);
  if (!found || found.agentId !== agent.id) notFound();
  // Other people's prompts are not shown (lib/runPrivacy.ts): the timing is,
  // since it says how the run went and nothing of what it was about.
  const [me, admin, ctx] = await Promise.all([sessionPrincipal(), sessionCan("admin:manage"), viewContext()]);
  const run = privateRun(found, { id: me?.id ?? null, admin: Boolean(admin) });
  // The transcript: the run's own person or an admin, in Expert, never a guess.
  const mayRead = ctx.view === "expert" && Boolean(me) && (Boolean(admin) || (found.principalId !== null && found.principalId === me?.id));
  const said = mayRead ? await getRunTranscript(run.id) : null;
  // "What went wrong" ends here (docs/effective-agents-review.md, E3): the
  // run's own person, with a skill run, can keep it as a test case and go
  // straight to the brief. Managing is checked again by the action.
  const own = Boolean(me) && found.principalId !== null && found.principalId === me?.id;
  const mayKeep = own && Boolean(found.skillId) && Boolean(await sessionCan("agent:manage"));

  const timeline = isTimeline(run.timeline) ? run.timeline : null;
  const reading = timeline ? readTimeline(timeline, run.latencyMs) : null;
  // The run that started this one, and the runs this one started: a hand-off
  // when it finished, or an agent it asked while it ran.
  const [parent, children] = await Promise.all([
    run.parentSessionId ? getRunTiming(run.parentSessionId).then(async (p) => (p ? { ...p, agent: p.agentId ? await getAgent(p.agentId) : null } : null)) : null,
    listChildRuns(run.id),
  ]);

  return (
    <main className="mx-auto max-w-[70rem] px-5 py-7 lg:px-8">
      <Link href={`/agents/${agent.slug}`} className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← {agent.name}
      </Link>

      <header className="mt-3">
        <div className="eyebrow flex flex-wrap items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 ${run.status === "running" ? "ctx-blink" : ""}`}
            style={{ background: run.status === "failed" ? "var(--brand)" : "var(--ai)" }}
          />
          Run · {run.status}
          {run.skill && <span>· {run.skill}</span>}
          <span className="mono normal-case tracking-normal text-[var(--faint)]">{run.id}</span>
        </div>
        <h1 className="mt-3 line-clamp-3 max-w-3xl text-2xl md:text-3xl">{run.promptHidden ? hiddenPromptLabel(run) : firstLine(run.prompt)}</h1>
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <Fact label="Took" value={run.latencyMs !== null ? duration(run.latencyMs) : "—"} />
          <Fact label="Cost" value={run.costUsd !== null ? money(run.costUsd) : "—"} />
          <Fact label="Model calls" value={timeline ? String(timeline.turns.length) : "—"} />
          <Fact label="Tokens in / out" value={run.tokens ? `${count(inTokens(run.tokens))} / ${count(run.tokens.outputTokens ?? 0)}` : "—"} />
          <Fact label="Model · effort" value={[run.model, run.effort].filter(Boolean).join(" · ") || "default"} />
          <Fact label="Started" value={new Date(run.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} />
        </dl>
        {own && (mayKeep || !mayRead) && (
          <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {mayKeep && <SaveCaseButton runId={run.id} />}
            {mayKeep && (
              <Link href={`/agents/${agent.slug}#settings`} className="underline underline-offset-2 hover:text-[var(--brand-ink)]">
                Edit the brief
              </Link>
            )}
            {!mayRead && <span className="text-[var(--muted)]">The transcript is shown in the Expert view.</span>}
          </p>
        )}
        {run.status === "failed" && run.error && <p className="mt-3 max-w-3xl text-sm text-[var(--danger)]">{run.error}</p>}
        {(parent || children.length > 0) && (
          <ul className="mt-4 flex flex-col gap-1 text-sm">
            {parent && (
              <li>
                Started by{" "}
                {parent.agent ? (
                  <Link href={`/agents/${parent.agent.slug}/runs/${parent.id}`} className="font-medium underline-offset-2 hover:underline">
                    a run of {parent.agent.name}
                  </Link>
                ) : (
                  <span className="mono">{parent.id}</span>
                )}{" "}
                <span className="text-[var(--muted)]">({run.depth} deep)</span>
              </li>
            )}
            {children.map((c) => (
              <li key={c.id}>
                Started{" "}
                {c.agentSlug ? (
                  <Link href={`/agents/${c.agentSlug}/runs/${c.id}`} className="font-medium underline-offset-2 hover:underline">
                    {c.agentName}
                  </Link>
                ) : (
                  <span className="mono">{c.id}</span>
                )}
                <span className="text-[var(--muted)]">
                  {" "}
                  · {c.status}
                  {c.latencyMs !== null ? ` · ${duration(c.latencyMs)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </header>

      {!timeline || !reading ? (
        <section className="panel mt-6 p-5 md:p-6">
          <div className="eyebrow">Where the time went</div>
          <p className="mt-3 max-w-2xl text-sm text-[var(--muted)]">
            {run.status === "running"
              ? "Still running. The breakdown appears when it finishes."
              : "This run was recorded before the hub kept timings. Runs from now on show where their time went."}
          </p>
        </section>
      ) : (
        <>
          <section className="panel mt-6 p-5 md:p-6">
            <div className="eyebrow">Where the time went</div>
            <p className="mt-3 max-w-3xl text-[var(--text)]">{reading.verdict}</p>
            <Bar parts={reading.parts} className="mt-5 h-5" />
            <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {reading.parts.map((p) => (
                <li key={p.key} className="flex items-baseline gap-2">
                  <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 self-center" style={{ background: p.color }} />
                  <span className="min-w-0 flex-1">{p.label}</span>
                  <span className="metric font-bold">{duration(p.ms)}</span>
                  <span className="w-10 text-right text-xs text-[var(--muted)]">{Math.round(p.share * 100)}%</span>
                </li>
              ))}
            </ul>
            {reading.notes.length > 0 && (
              <ul className="mt-5 flex max-w-3xl flex-col gap-1.5 border-t border-[var(--border)] pt-4 text-sm text-[var(--text-soft)]">
                {reading.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel mt-6 p-5 md:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="eyebrow">Turn by turn</div>
              <span className="text-xs text-[var(--muted)]">Bars are to scale on the run&apos;s own clock</span>
            </div>
            <ol className="mt-3 flex flex-col">
              {timeline.turns.map((t) => (
                <Turn key={t.turn} turn={t} totalMs={reading.totalMs} />
              ))}
            </ol>
          </section>

          {said && <Said run={said} days={retentionPolicy().transcriptsDays} />}

          <section className="panel mt-6 p-5 md:p-6">
            <div className="eyebrow">What the first request carried</div>
            <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
              Approximate, from characters. Every later turn carries all of this again, plus each tool result before it.
            </p>
            <Shape shape={timeline.prompt} />
          </section>
        </>
      )}
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="metric mt-0.5 font-bold">{value}</dd>
    </div>
  );
}

function Bar({ parts, className = "" }: { parts: Pick<Part, "key" | "label" | "share" | "color">[]; className?: string }) {
  return (
    <div className={`flex w-full overflow-hidden bg-[var(--panel-inset)] ${className}`} role="img" aria-label={parts.map((p) => `${p.label} ${Math.round(p.share * 100)}%`).join(", ")}>
      {parts.map((p) => (
        <span key={p.key} title={p.label} style={{ width: `${Math.max(p.share * 100, 0.5)}%`, background: p.color }} />
      ))}
    </div>
  );
}

function Turn({ turn, totalMs }: { turn: TurnTiming; totalMs: number }) {
  const at = (ms: number) => `${(ms / totalMs) * 100}%`;
  const reading = turn.firstTokenMs ?? 0;
  const rest = Math.max(0, turn.totalMs - reading - turn.thinkingMs - turn.writingMs - turn.toolInputMs);
  const segments: [keyof typeof PART_STYLE, number][] = [
    ["reading", reading],
    ["thinking", turn.thinkingMs],
    ["writing", turn.writingMs],
    ["toolArgs", turn.toolInputMs],
    ["other", rest],
  ];
  const toolStart = turn.startMs + turn.totalMs;
  const read = turn.inputTokens + turn.cacheReadTokens + turn.cacheCreationTokens;
  return (
    <li className="grid grid-cols-1 gap-x-4 gap-y-1.5 border-t border-[var(--border)] py-3 md:grid-cols-[9rem_minmax(0,1fr)_12rem]">
      <div className="text-sm">
        <span className="font-bold">Turn {turn.turn}</span>{" "}
        <span className="text-[var(--muted)]">{duration(turn.totalMs)}</span>
      </div>
      <div className="relative h-4 self-center bg-[var(--panel-inset)]">
        <div className="absolute inset-y-0 flex" style={{ left: at(turn.startMs), width: at(turn.totalMs) }}>
          {segments
            .filter(([, ms]) => ms > 0)
            .map(([key, ms]) => (
              <span key={key} title={`${PART_STYLE[key].label} ${duration(ms)}`} style={{ width: `${(ms / Math.max(turn.totalMs, 1)) * 100}%`, background: PART_STYLE[key].color }} />
            ))}
        </div>
        {turn.tools.length > 0 && (
          <div
            className="absolute inset-y-0"
            title={turn.tools.map((c) => `${c.name} ${duration(c.ms)}`).join(", ")}
            style={{ left: at(toolStart), width: at(turn.tools.reduce((n, c) => n + c.ms, 0)), background: PART_STYLE.tools.color }}
          />
        )}
      </div>
      <div className="text-xs text-[var(--muted)] md:text-right">
        read {count(read)}
        {turn.cacheReadTokens > 0 && <> ({count(turn.cacheReadTokens)} cached)</>} · wrote {count(turn.outputTokens)}
      </div>
      {turn.tools.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs md:col-start-2 md:col-end-4">
          {turn.tools.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-1.5 w-1.5" style={{ background: c.error ? "var(--danger)" : PART_STYLE.tools.color }} />
              <span className="mono">{c.name}</span>
              <span className="text-[var(--muted)]">
                {duration(c.ms)} · returned ≈{count(c.resultChars / 4)} tokens{c.error ? " · failed" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Shape({ shape }: { shape: RunTimeline["prompt"] }) {
  const rows: [string, number, string][] = [
    ["The agent's brief", shape.brief, "var(--c-rules)"],
    ["Retrieved knowledge", shape.context, "var(--c-src)"],
    ["Tool definitions", shape.tools, "var(--c-person)"],
    ["Earlier chat turns", shape.history, "var(--faint)"],
    ["The request", shape.prompt, "var(--ai)"],
  ];
  const total = Math.max(rows.reduce((n, [, v]) => n + v, 0), 1);
  return (
    <>
      <Bar className="mt-4 h-4" parts={rows.filter(([, v]) => v > 0).map(([label, v, color]) => ({ key: label as never, label, share: v / total, color }))} />
      <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, v, color]) => (
          <li key={label} className={`flex items-baseline gap-2 ${v === 0 ? "text-[var(--muted)]" : ""}`}>
            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 self-center" style={{ background: v ? color : "var(--border-strong)" }} />
            <span className="min-w-0 flex-1">{label}</span>
            <span className="metric font-bold">≈{count(v)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function firstLine(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 220 ? `${line.slice(0, 220)}…` : line || "(no prompt)";
}

function inTokens(t: NonNullable<Awaited<ReturnType<typeof getRunTiming>>>["tokens"]): number {
  return (t?.inputTokens ?? 0) + (t?.cacheReadTokens ?? 0) + (t?.cacheCreationTokens ?? 0);
}

// The transcript, turn by turn, as stored (docs/effective-agents-review.md,
// E2). Plain text throughout: what the model wrote, what it asked each tool,
// what came back. Long tool results are cut to a first page with the size
// said, since "read the transcript" means reading the decisions, not every
// byte of a document a tool returned. Thinking is not stored with content
// and is not shown.

const PAGE = 2000;

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string };
type Message = { role?: string; content?: string | Block[] };

function Said({ run, days }: { run: RunTranscript; days: number }) {
  const messages = Array.isArray(run.transcript) ? (run.transcript as Message[]) : [];
  return (
    <section className="panel mt-6 p-5 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="eyebrow">What was said</div>
        <span className="text-xs text-[var(--muted)]">Only you and admins can read this, for {days} days after the run.</span>
      </div>
      {run.sensitivity === "special" ? (
        <p className="mt-3 max-w-2xl text-sm text-[var(--muted)]">Not kept: this run touched special-category material, so no record of the conversation is stored.</p>
      ) : run.transcriptDroppedAt || messages.length === 0 ? (
        <p className="mt-3 max-w-2xl text-sm text-[var(--muted)]">The record of this conversation was removed after the hub&apos;s retention period. The numbers above stay.</p>
      ) : (
        <ol className="mt-3 flex flex-col">
          {messages.map((m, i) => (
            <li key={i} className="border-t border-[var(--border)] py-3">
              <div className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--muted)]">{m.role === "assistant" ? "Agent" : i === 0 ? "Request" : "Tools"}</div>
              <div className="mt-1.5 flex flex-col gap-2">{blocksOf(m).map((b, j) => <BlockView key={j} block={b} />)}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function blocksOf(m: Message): Block[] {
  if (typeof m.content === "string") return [{ type: "text", text: m.content }];
  return Array.isArray(m.content) ? m.content : [];
}

function BlockView({ block }: { block: Block }) {
  if (block.type === "text") return <p className="whitespace-pre-wrap text-sm">{page(block.text ?? "")}</p>;
  if (block.type === "tool_use") {
    return (
      <div className="inset p-3 text-xs">
        <div>
          Called <span className="mono font-medium">{block.name}</span>
        </div>
        <pre className="mono mt-1 whitespace-pre-wrap">{page(JSON.stringify(block.input ?? {}, null, 1))}</pre>
      </div>
    );
  }
  if (block.type === "tool_result") {
    const body = resultText(block.content);
    return (
      <div className="inset p-3 text-xs">
        <div className="text-[var(--muted)]">Returned</div>
        <pre className="mono mt-1 whitespace-pre-wrap">{page(body)}</pre>
      </div>
    );
  }
  // Thinking blocks hold no content as stored; anything else is not shown.
  return null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : typeof (c as Block)?.text === "string" ? (c as Block).text : "")).join("\n");
  return "";
}

function page(s: string): string {
  return s.length > PAGE ? `${s.slice(0, PAGE)}\n… ${(s.length - PAGE).toLocaleString("en-GB")} more characters` : s;
}
