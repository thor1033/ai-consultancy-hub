import Link from "next/link";
import { agentRoster, type AgentRosterRow } from "@ai-hub/db";
import { money, rel } from "@/lib/format";

export const dynamic = "force-dynamic";

// The agents page is the company's org chart: the founders at the top, the
// functions they run as columns, and every agent filed under the function it
// works in with the person who answers for it. It answers two questions in
// this order — what needs me, and who does what — because a roster that
// leads with weekly totals buries the one agent waiting for an approval under
// five that are fine.
//
// Read on the server per request. It is a view of the store, not an editor:
// an agent's function and owner are set on its own page.

/**
 * The people agents report to. Owners are free text on the agent, so the
 * title is looked up by name here; a name not in this table is still shown,
 * without a title. This is the one place the hub knows who the founders are,
 * and it moves to a people table the day the hub has one worth pointing at.
 */
const PEOPLE: Record<string, { title: string }> = {
  "Ditlev Brygmann": { title: "CEO" },
  "Thor Simonsen": { title: "CTO" },
};

/** Columns in the order the company reads them; anything else follows, A–Z. */
const FUNCTION_ORDER = ["Office of the founders", "Delivery", "Product", "Legal & Compliance"];
const UNFILED = "Not filed yet";

// One colour per owner, so an agent's reporting line is readable from its
// card without drawing a line across the page to its founder. The palette is
// the hub's node colours; a third owner would get the third one.
const OWNER_COLOURS = ["var(--brand)", "var(--ai)", "var(--c-person)", "var(--c-src)", "var(--c-skill)"];

const serverNames = (a: AgentRosterRow) =>
  (a.mcpServers ?? [])
    .map((e) => (typeof e === "string" ? e : String((e as { name?: unknown }).name ?? "")))
    .filter((n) => n && n !== "memory");

interface Mark {
  text: string;
  colour: string;
  /** Needs a person: shown in the attention strip as well as on the card. */
  urgent?: boolean;
  href?: string;
}

/** What is worth saying about an agent beyond its name. Urgent first. */
function marksFor(a: AgentRosterRow): Mark[] {
  const marks: Mark[] = [];
  if (a.pendingProposals > 0) {
    marks.push({
      text: `${a.pendingProposals} write${a.pendingProposals === 1 ? "" : "s"} awaiting approval`,
      colour: "var(--brand)",
      urgent: true,
      href: "/approvals",
    });
  }
  if (a.failed7d > 0) {
    marks.push({ text: `${a.failed7d} failed run${a.failed7d === 1 ? "" : "s"} this week`, colour: "var(--brand)", urgent: true });
  }
  if (a.scheduleError) marks.push({ text: "A schedule errored", colour: "var(--brand)", urgent: true });
  if (!a.enabled) marks.push({ text: "Switched off", colour: "var(--faint)" });
  if (a.placement === "local") marks.push({ text: "Claude Code only", colour: "var(--c-src)" });
  if (a.placement === "both") marks.push({ text: "Hub and Claude Code", colour: "var(--c-src)" });
  if (a.enabled && !a.lastRunAt) marks.push({ text: "Never run", colour: "var(--muted)" });
  if (a.schedulesEnabled > 0) {
    marks.push({ text: `${a.schedulesEnabled} schedule${a.schedulesEnabled === 1 ? "" : "s"} on`, colour: "var(--muted)" });
  }
  return marks;
}

const urgency = (a: AgentRosterRow) => (a.pendingProposals > 0 ? 3 : a.failed7d > 0 || a.scheduleError ? 2 : 0);

export default async function AgentsPage() {
  let roster: AgentRosterRow[] = [];
  let error: string | null = null;
  try {
    roster = await agentRoster();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load agents.";
  }

  const now = Date.now();
  const peak = Math.max(1, ...roster.flatMap((a) => a.runsByDay ?? []));

  // ── the structure ──────────────────────────────────────────────────────────
  const byFunction = new Map<string, AgentRosterRow[]>();
  for (const a of roster) {
    const key = a.functionName || UNFILED;
    byFunction.set(key, [...(byFunction.get(key) ?? []), a]);
  }
  const functions = [...byFunction.keys()].sort((x, y) => {
    if (x === UNFILED) return 1;
    if (y === UNFILED) return -1;
    const ix = FUNCTION_ORDER.indexOf(x);
    const iy = FUNCTION_ORDER.indexOf(y);
    if (ix !== -1 || iy !== -1) return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
    return x.localeCompare(y);
  });
  for (const list of byFunction.values()) {
    // What needs a person first, then the ones that are on, then by name.
    list.sort((x, y) => urgency(y) - urgency(x) || Number(y.enabled) - Number(x.enabled) || x.name.localeCompare(y.name));
  }

  // Owners in the table first, in its order, then anyone else named on an agent.
  const owners = [
    ...Object.keys(PEOPLE).filter((p) => roster.some((a) => a.owner === p)),
    ...[...new Set(roster.map((a) => a.owner).filter(Boolean))].filter((p) => !(p in PEOPLE)).sort(),
  ];
  const ownerColour = new Map(owners.map((o, i) => [o, OWNER_COLOURS[i % OWNER_COLOURS.length]]));
  const unfiled = roster.filter((a) => !a.functionName || !a.owner);
  const filed = functions.filter((f) => f !== UNFILED);

  // ── what needs a person ────────────────────────────────────────────────────
  const attention = roster
    .filter((a) => urgency(a) > 0)
    .sort((x, y) => urgency(y) - urgency(x) || x.name.localeCompare(y.name));
  const pending = roster.reduce((n, a) => n + a.pendingProposals, 0);

  // ── the week ───────────────────────────────────────────────────────────────
  const runs = roster.reduce((n, a) => n + a.runs7d, 0);
  const failed = roster.reduce((n, a) => n + a.failed7d, 0);
  const spend = roster.reduce((n, a) => n + a.spend7d, 0);
  const on = roster.filter((a) => a.enabled).length;
  const schedules = roster.reduce((n, a) => n + a.schedulesEnabled, 0);
  const memories = roster.reduce((n, a) => n + a.memoriesLoaded, 0);

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow">Agents</div>
          <h1 className="mt-3 text-3xl md:text-4xl">The company, by function.</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
            {roster.length === 0
              ? "No agents yet."
              : `${roster.length} agent${roster.length === 1 ? "" : "s"}${on !== roster.length ? `, ${on} on,` : ""} across ${filed.length} function${
                  filed.length === 1 ? "" : "s"
                }. Open an agent to talk to it or change its brief; its function and owner are under Settings.`}
          </p>
        </div>
        <Link href="/agents/new" className="btn-brand min-h-11">
          New agent
        </Link>
      </header>

      {error ? (
        <div className="panel notice-warning mt-6 p-4 text-sm text-[var(--warning)]">{error}</div>
      ) : roster.length === 0 ? (
        <section className="panel mt-6 p-8 md:p-12">
          <div className="eyebrow">No agents yet</div>
          <h2 className="mt-3 max-w-2xl text-2xl md:text-3xl">Hire the first one.</h2>
          <p className="mt-3 max-w-2xl text-[var(--text-soft)]">
            Give it a brief, the tools it may use and the knowledge it may read. It keeps its own memory from the
            first conversation on.
          </p>
          <Link href="/agents/new" className="btn-brand mt-6 min-h-11">
            New agent
          </Link>
        </section>
      ) : (
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_13rem]">
          <div className="min-w-0">
            {/* ── Needs you ─────────────────────────────────────────────── */}
            <section aria-labelledby="attention" className="rule-heavy pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <h2 id="attention" className="eyebrow">
                  Needs you
                </h2>
                {pending > 0 && (
                  <Link href="/approvals" className="text-xs text-[var(--brand-ink)] hover:underline">
                    Open the approvals queue →
                  </Link>
                )}
              </div>
              {attention.length === 0 && unfiled.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--text-soft)]">
                  Nothing. {runs === 0 ? "No agent has run this week." : `${runs} run${runs === 1 ? "" : "s"} this week, none failed, nothing waiting for approval.`}
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--border)]">
                  {attention.map((a) => {
                    const urgent = marksFor(a).filter((m) => m.urgent);
                    return (
                      <li key={a.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-sm">
                        <Link href={`/agents/${a.slug}`} className="font-medium hover:text-[var(--brand)]">
                          {a.name}
                        </Link>
                        {urgent.map((m) =>
                          m.href ? (
                            <Link key={m.text} href={m.href} className="flex items-center gap-1.5 text-[var(--text-soft)] hover:text-[var(--brand)]">
                              <span aria-hidden className="inline-block h-2 w-2" style={{ background: m.colour }} />
                              {m.text} →
                            </Link>
                          ) : (
                            <span key={m.text} className="flex items-center gap-1.5 text-[var(--text-soft)]">
                              <span aria-hidden className="inline-block h-2 w-2" style={{ background: m.colour }} />
                              {m.text}
                            </span>
                          ),
                        )}
                      </li>
                    );
                  })}
                  {unfiled.length > 0 && (
                    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-sm">
                      <span className="font-medium">
                        {unfiled.length} agent{unfiled.length === 1 ? "" : "s"} not filed
                      </span>
                      <span className="text-[var(--text-soft)]">
                        {unfiled.map((a) => a.name).join(", ")} — give {unfiled.length === 1 ? "it" : "them"} a function and an
                        owner under Settings.
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </section>

            {/* ── The chart ─────────────────────────────────────────────── */}
            <section aria-label="Org chart" className="mt-10">
              {/* The founders. One card each, with the colour that marks their agents. */}
              <ol className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
                {owners.map((name) => {
                  const reports = roster.filter((a) => a.owner === name);
                  const title = PEOPLE[name]?.title;
                  return (
                    <li key={name} className="panel-2 flex items-start gap-3 p-4">
                      <span aria-hidden className="mt-1.5 inline-block h-3 w-3 shrink-0" style={{ background: ownerColour.get(name) }} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-lg font-bold">{name}</span>
                          {title && <span className="eyebrow">{title}</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--muted)]">
                          {reports.length} agent{reports.length === 1 ? "" : "s"}
                          {reports.filter((a) => urgency(a) > 0).length > 0 && (
                            <span className="text-[var(--brand-ink)]">
                              {" "}
                              · {reports.filter((a) => urgency(a) > 0).length === 1 ? "one needs" : `${reports.filter((a) => urgency(a) > 0).length} need`} a decision
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>

              {/* The line the functions hang from. */}
              <div aria-hidden className="mt-5 border-t-2 border-[var(--text)]" />

              <ol className="grid gap-x-6 gap-y-8 pt-5 sm:grid-cols-2 xl:grid-cols-4">
                {filed.map((fn) => {
                  const agents = byFunction.get(fn) ?? [];
                  return (
                    <li key={fn} className="min-w-0">
                      <div className="flex items-baseline justify-between gap-3 border-b border-[var(--text)] pb-2">
                        <h3 className="text-base font-bold">{fn}</h3>
                        <span className="mono text-xs text-[var(--muted)]">{String(agents.length).padStart(2, "0")}</span>
                      </div>
                      {/* The hanging line: a hairline down the column, a square node at each agent. */}
                      <ol className="relative mt-3 flex flex-col gap-3 border-l border-[var(--border-strong)] pl-4">
                        {agents.map((a) => (
                          <AgentCard key={a.id} agent={a} colour={ownerColour.get(a.owner) ?? "var(--faint)"} now={now} peak={peak} />
                        ))}
                      </ol>
                    </li>
                  );
                })}
              </ol>

              {/* Outside the structure until someone files them: a strip, not a column. */}
              {(byFunction.get(UNFILED) ?? []).length > 0 && (
                <div className="mt-10 border-t border-dashed border-[var(--border-strong)] pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h3 className="text-base font-bold text-[var(--muted)]">{UNFILED}</h3>
                    <span className="basis-full text-xs text-[var(--muted)] sm:basis-auto">Not on the chart until given a function and an owner.</span>
                  </div>
                  <ol className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {(byFunction.get(UNFILED) ?? []).map((a) => (
                      <AgentCard key={a.id} agent={a} colour={ownerColour.get(a.owner) ?? "var(--faint)"} now={now} peak={peak} bare />
                    ))}
                  </ol>
                </div>
              )}
            </section>
          </div>

          {/* ── This week, at the side ────────────────────────────────── */}
          <aside aria-label="This week" className="lg:border-l lg:border-[var(--border)] lg:pl-6">
            <div className="eyebrow">This week</div>
            <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-4 lg:grid-cols-1">
              <Figure value={`${runs}`} label="Runs" node="var(--ai)" />
              <Figure value={`${failed}`} label="Failed" node={failed ? "var(--brand)" : undefined} />
              <Figure value={money(spend)} label="Spend" />
              <Figure value={`${on}`} sub={roster.length !== on ? `of ${roster.length}` : undefined} label="Agents on" />
              <Figure value={`${schedules}`} label="Schedules on" />
              <Figure value={`${memories}`} label="Memories loaded" node="var(--c-mem)" />
            </dl>
          </aside>
        </div>
      )}
    </main>
  );
}

function Figure({ value, sub, label, node }: { value: string; sub?: string; label: string; node?: string }) {
  // Term before definition in the markup, number above the label on screen.
  return (
    <div className="flex flex-col">
      <dt className="order-2 mt-0.5 text-xs text-[var(--muted)]">{label}</dt>
      <dd className="metric order-1 flex items-baseline gap-2 text-2xl font-bold">
        {node && <span aria-hidden className="inline-block h-2 w-2 shrink-0 self-center" style={{ background: node }} />}
        {value}
        {sub && <span className="text-xs font-normal text-[var(--muted)]">{sub}</span>}
      </dd>
    </div>
  );
}

function AgentCard({
  agent: a,
  colour,
  now,
  peak,
  bare = false,
}: {
  agent: AgentRosterRow;
  colour: string;
  now: number;
  peak: number;
  /** Off the chart's hanging line: no node. */
  bare?: boolean;
}) {
  const marks = marksFor(a);
  const tools = serverNames(a);
  return (
    <li className="relative">
      {/* The node on the hanging line, in the owner's colour. */}
      {!bare && <span aria-hidden className="absolute -left-[1.3rem] top-5 inline-block h-2.5 w-2.5" style={{ background: colour }} />}
      <Link
        href={`/agents/${a.slug}`}
        className={`panel panel-hover group block p-4 ${a.enabled ? "" : "opacity-60"} ${
          urgency(a) === 3 ? "border-l-2 border-l-[var(--brand)]" : ""
        }`}
      >
        <h4 className="text-base font-bold leading-tight transition-colors group-hover:text-[var(--brand)]">{a.name}</h4>
        <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-[var(--text-soft)]">
          {a.description || <span className="text-[var(--muted)]">No description yet.</span>}
        </p>

        {marks.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {marks.map((m) => (
              <li key={m.text} className={`flex items-center gap-1.5 ${m.urgent ? "text-[var(--text)]" : "text-[var(--muted)]"}`}>
                <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0" style={{ background: m.colour }} />
                {m.text}
              </li>
            ))}
          </ul>
        )}

        <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Reports to</dt>
            <span aria-hidden className="inline-block h-1.5 w-1.5" style={{ background: colour }} />
            <dd>{a.owner || "No owner"}</dd>
          </div>
          <div>
            <dt className="sr-only">Tools</dt>
            <dd>{tools.length ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : "Memory only"}</dd>
          </div>
          <div>
            <dt className="sr-only">Skills</dt>
            <dd>{a.skills ? `${a.skills} skill${a.skills === 1 ? "" : "s"}` : null}</dd>
          </div>
        </dl>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="text-xs text-[var(--muted)]">
            <span className="text-[var(--text)]">{a.runs7d}</span> run{a.runs7d === 1 ? "" : "s"} · last{" "}
            <span className="text-[var(--text-soft)]">{rel(a.lastRunAt, now, "never")}</span>
            {a.lastRunStatus === "failed" && <span className="text-[var(--danger)]"> · failed</span>}
          </div>
          <div className="flex items-end gap-[2px]" role="img" aria-label={`${a.runs7d} runs in the last 7 days`}>
            {(a.runsByDay ?? []).map((n, i) => (
              <span
                key={i}
                className="inline-block w-2"
                style={{ height: n ? `${4 + (n / peak) * 16}px` : "2px", background: n ? "var(--ai)" : "var(--border-strong)" }}
              />
            ))}
          </div>
        </div>
      </Link>
    </li>
  );
}
