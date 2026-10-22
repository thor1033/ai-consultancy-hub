import Link from "next/link";
import {
  agentRoster,
  hubActivity,
  listRecentRuns,
  listSchedules,
  type AgentRosterRow,
  type HubDay,
  type HubRun,
  type McpServerRow,
  type Schedule,
} from "@ai-hub/db";
import { listDocuments, embedderStatus, type DocumentSummary } from "@ai-hub/rag";
import { listRegisteredServers } from "@/lib/mcpCatalog";
import { sessionKnowledgeAccess } from "@/lib/sessionPrincipal";
import { DAYS, cadence, money, rel } from "@/lib/format";

export const dynamic = "force-dynamic";

// The overview. It opens on the one thing a person checks first — does
// anything need me? — then shows what the hub has been doing and who is doing
// it, and ends with what it knows and can reach. Every number links to the page
// where it can be acted on.

interface Attention {
  text: string;
  detail?: string;
  href: string;
  level: "danger" | "notice";
}

const names = (entries: unknown): string[] =>
  Array.isArray(entries)
    ? entries.map((e) => (typeof e === "string" ? e : String((e as { name?: unknown })?.name ?? ""))).filter(Boolean)
    : [];

export default async function OverviewPage() {
  // Each source is read independently: an empty knowledge base or an MCP server
  // that will not start should cost you that panel, not the whole page.
  const [roster, days, recent, docs, servers, schedules] = await Promise.all([
    agentRoster().catch(() => [] as AgentRosterRow[]),
    hubActivity(14).catch(() => [] as HubDay[]),
    listRecentRuns(8).catch(() => [] as HubRun[]),
    sessionKnowledgeAccess()
      .then((access) => listDocuments(access))
      .catch(() => [] as DocumentSummary[]),
    listRegisteredServers().catch(() => [] as McpServerRow[]),
    listSchedules().catch(() => [] as Schedule[]),
  ]);

  const now = Date.now();
  const embedder = embedderStatus();
  const thisWeek = days.slice(-7);
  const lastWeek = days.slice(-14, -7);
  const sum = (d: HubDay[], k: "runs" | "failed" | "spend") => d.reduce((n, x) => n + x[k], 0);
  const runs = sum(thisWeek, "runs");
  const failed = sum(thisWeek, "failed");
  const spend = sum(thisWeek, "spend");
  const runsBefore = sum(lastWeek, "runs");
  const spendBefore = sum(lastWeek, "spend");
  const agentsOn = roster.filter((a) => a.enabled);
  const busy = roster.filter((a) => a.runs7d > 0).length;
  const chunks = docs.reduce((n, d) => n + d.chunkCount, 0);
  const collections = new Set(docs.map((d) => d.collection).filter(Boolean)).size;
  const unfiled = docs.filter((d) => !d.collection).length;
  const newestDoc = docs.reduce<DocumentSummary | null>((a, d) => (!a || d.createdAt > a.createdAt ? d : a), null);
  const byId = new Map(roster.map((a) => [a.id, a]));
  const usedBy = (server: string) => roster.filter((a) => names(a.mcpServers).includes(server));

  // ── what needs a person ────────────────────────────────────────────────────
  const attention: Attention[] = [];
  if (!embedder.production) {
    attention.push({
      level: "danger",
      text: "Knowledge search is running on the development fallback",
      detail: `Embeddings come from ${embedder.name}, so retrieval returns confident nonsense. Set VOYAGE_API_KEY and re-index.`,
      href: "/knowledge",
    });
  }
  for (const a of roster) {
    if (a.failed7d) {
      attention.push({
        level: "danger",
        text: `${a.name} failed ${a.failed7d} run${a.failed7d === 1 ? "" : "s"} this week`,
        href: `/agents/${a.slug}`,
      });
    }
  }
  for (const s of schedules) {
    if (s.enabled && s.lastError) {
      const agent = byId.get(s.agentId);
      attention.push({
        level: "danger",
        text: `Schedule “${s.name}” errored`,
        detail: s.lastError,
        href: agent ? `/agents/${agent.slug}` : "/agents",
      });
    }
  }
  for (const s of servers) {
    const users = usedBy(s.name).filter((a) => a.enabled);
    if (!s.enabled && users.length) {
      attention.push({
        level: "danger",
        text: `${s.label || s.name} is switched off`,
        detail: `${users.map((a) => a.name).join(", ")} ${users.length === 1 ? "relies" : "rely"} on it.`,
        href: `/mcp/${s.name}`,
      });
    }
  }
  for (const a of agentsOn) {
    if (!a.lastRunAt) attention.push({ level: "notice", text: `${a.name} has never run`, href: `/agents/${a.slug}` });
  }
  if (unfiled > 0) {
    attention.push({
      level: "notice",
      text: `${unfiled} document${unfiled === 1 ? " is" : "s are"} not in a collection`,
      detail: "Agents scoped to a collection will not find them.",
      href: "/knowledge",
    });
  }
  const urgent = attention.filter((a) => a.level === "danger").length;

  const headline =
    urgent > 0 ? `${urgent} thing${urgent === 1 ? " needs" : "s need"} you.` : runs > 0 ? "All clear." : "Quiet week.";

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow">
            Overview ·{" "}
            {new Date(now).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
          </div>
          <h1 className="mt-3 text-3xl md:text-4xl">{headline}</h1>
          <p className="mt-2 max-w-2xl text-[var(--text-soft)]">
            {runs > 0
              ? `${runs} run${runs === 1 ? "" : "s"} by ${busy} agent${busy === 1 ? "" : "s"} this week, for ${money(spend)}.`
              : "No agent has run this week."}{" "}
            {roster.length} agent{roster.length === 1 ? "" : "s"}, {docs.length} document{docs.length === 1 ? "" : "s"} and{" "}
            {servers.length} tool server{servers.length === 1 ? "" : "s"} on the hub.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/knowledge" className="btn min-h-11">
            Add knowledge
          </Link>
          <Link href="/agents/new" className="btn-brand min-h-11">
            New agent
          </Link>
        </div>
      </header>

      <div className="rule-heavy mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat value={`${runs}`} label="Runs · 7 days" node="var(--ai)" delta={delta(runs, runsBefore)} href="/agents" />
        <Stat value={`${failed}`} label="Failed · 7 days" node={failed ? "var(--brand)" : undefined} href="/agents" />
        <Stat value={money(spend)} label="Spend · 7 days" delta={delta(spend, spendBefore, money)} href="/agents" />
        <Stat
          value={`${agentsOn.length}`}
          sub={agentsOn.length !== roster.length ? `of ${roster.length}` : undefined}
          label="Agents on"
          href="/agents"
        />
        <Stat value={`${docs.length}`} sub={`${chunks} passages`} label="Documents" href="/knowledge" />
        <Stat
          value={`${servers.filter((s) => s.enabled).length}`}
          sub={servers.some((s) => !s.enabled) ? `of ${servers.length}` : undefined}
          label="Tool servers on"
          node="var(--c-src)"
          outline
          href="/mcp"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="panel p-5 md:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="eyebrow">Activity · 14 days</div>
            <div className="flex gap-4 text-xs text-[var(--muted)]">
              <Key color="var(--ai)">Runs</Key>
              <Key color="var(--brand)">Failed</Key>
            </div>
          </div>
          <Activity days={days} />
          <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-[var(--border)] pt-4 text-sm sm:grid-cols-4">
            <Fig k="This week" v={`${runs} runs`} />
            <Fig k="Last week" v={`${runsBefore} runs`} muted />
            <Fig k="Spend this week" v={money(spend)} />
            <Fig k="Last week" v={money(spendBefore)} muted />
          </dl>
        </section>

        {/* First on a phone: it is what a person opens the page to find out. */}
        <section className="panel order-first p-5 md:p-6 lg:order-none">
          <div className="flex items-baseline justify-between gap-2">
            <div className="eyebrow">Needs attention</div>
            {attention.length > 0 && <span className="mono text-xs text-[var(--muted)]">{attention.length}</span>}
          </div>
          {attention.length === 0 ? (
            <div className="mt-4 flex items-start gap-3">
              <span aria-hidden className="mt-1.5 inline-block h-2.5 w-2.5 bg-[var(--ai)]" />
              <p className="text-sm text-[var(--text-soft)]">
                Nothing. Every agent that ran this week succeeded, schedules are healthy and every tool server an agent
                uses is on.
              </p>
            </div>
          ) : (
            <ul className="mt-3 flex flex-col">
              {attention.slice(0, 7).map((a, i) => (
                <li key={i} className="border-t border-[var(--border)] first:border-t-0">
                  <Link href={a.href} className="group grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 py-2.5">
                    <span
                      aria-hidden
                      className="mt-1.5 inline-block h-2 w-2"
                      style={{ background: a.level === "danger" ? "var(--brand)" : "var(--border-strong)" }}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm group-hover:text-[var(--brand)]">{a.text}</span>
                      {a.detail && <span className="mt-0.5 line-clamp-2 block text-xs text-[var(--muted)]">{a.detail}</span>}
                    </span>
                    <span aria-hidden className="text-sm text-[var(--muted)] group-hover:text-[var(--brand)]">
                      →
                    </span>
                  </Link>
                </li>
              ))}
              {attention.length > 7 && (
                <li className="border-t border-[var(--border)] pt-2.5 text-xs text-[var(--muted)]">
                  And {attention.length - 7} more.
                </li>
              )}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="panel p-5 md:p-6">
          <div className="flex items-baseline justify-between gap-2">
            <div className="eyebrow">Latest runs</div>
            <span className="hidden text-xs text-[var(--muted)] sm:inline">Chats, schedules and client calls</span>
          </div>
          {recent.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              No agent has run yet. Open one on the{" "}
              <Link href="/agents" className="text-[var(--text)] underline underline-offset-2">
                Agents
              </Link>{" "}
              page and talk to it.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col">
              {recent.map((r) => (
                <li key={r.id} className="border-t border-[var(--border)]">
                  <Link
                    href={r.agentSlug ? `/agents/${r.agentSlug}` : "/agents"}
                    className="group grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 py-2.5"
                  >
                    <span
                      aria-label={r.status}
                      title={r.status}
                      className={`mt-1.5 inline-block h-2 w-2 ${r.status === "running" ? "ctx-blink" : ""}`}
                      style={{ background: r.status === "failed" ? "var(--brand)" : "var(--ai)" }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm group-hover:text-[var(--brand)]">
                        {r.prompt || <span className="text-[var(--muted)]">(no prompt)</span>}
                      </span>
                      <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-[var(--muted)]">
                        <span className="font-medium text-[var(--text-soft)]">{r.agentName ?? "Workbench"}</span>
                        {r.skill && (
                          <span className="inline-flex items-center gap-1">
                            <span aria-hidden className="inline-block h-1.5 w-1.5 rotate-45 bg-[var(--c-skill)]" />
                            {r.skill}
                          </span>
                        )}
                        {r.costUsd !== null && <span>{money(r.costUsd)}</span>}
                        {r.latencyMs !== null && <span>{(r.latencyMs / 1000).toFixed(1)}s</span>}
                        {r.status === "failed" && <span className="text-[var(--danger)]">failed</span>}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-xs text-[var(--muted)]">{rel(r.at, now)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel p-5 md:p-6">
          <div className="flex items-baseline justify-between gap-2">
            <div className="eyebrow">Agents</div>
            <Link href="/agents" className="text-xs text-[var(--muted)] hover:text-[var(--brand)]">
              All agents →
            </Link>
          </div>
          {roster.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              None yet.{" "}
              <Link href="/agents/new" className="text-[var(--text)] underline underline-offset-2">
                Hire the first one
              </Link>
              .
            </p>
          ) : (
            <ul className="mt-3 flex flex-col">
              {roster.map((a) => (
                <AgentLine key={a.id} agent={a} now={now} />
              ))}
            </ul>
          )}
          <Link
            href="/context"
            className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3 text-sm hover:text-[var(--brand)]"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="inline-block h-2 w-2 shrink-0 bg-[var(--c-mem)]" />
              <span>
                {roster.reduce((n, a) => n + a.memoriesLoaded, 0)} memories loaded{" "}
                <span className="text-[var(--muted)]">· {roster.reduce((n, a) => n + a.memoriesAside, 0)} set aside</span>
              </span>
            </span>
            <span className="shrink-0 whitespace-nowrap text-xs text-[var(--muted)]">Context →</span>
          </Link>
        </section>
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <section className="panel flex flex-col p-5 md:p-6">
          <div className="flex items-baseline justify-between gap-2">
            <div className="eyebrow">Knowledge</div>
            <Link href="/knowledge" className="text-xs text-[var(--muted)] hover:text-[var(--brand)]">
              Open →
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            <Fig k="Documents" v={`${docs.length}`} big />
            <Fig k="Passages" v={`${chunks}`} big />
            <Fig k="Collections" v={`${collections}`} big />
          </dl>
          <div className="mt-auto pt-4 text-xs text-[var(--muted)]">
            {newestDoc ? (
              <p className="truncate">
                Latest: <span className="text-[var(--text-soft)]">{newestDoc.title}</span> · {rel(newestDoc.createdAt, now)}
              </p>
            ) : (
              <p>Nothing indexed yet.</p>
            )}
            <p className="mt-1 flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5"
                style={{ background: embedder.production ? "var(--ai)" : "var(--brand)" }}
              />
              Embeddings: <span className="mono">{embedder.name}</span>
            </p>
          </div>
        </section>

        <section className="panel p-5 md:p-6">
          <div className="eyebrow">Schedules</div>
          {schedules.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              None. A schedule runs an agent on a timer — a Monday board sweep, a morning brief — as the person who set it
              up.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col">
              {schedules.slice(0, 5).map((s) => {
                const agent = byId.get(s.agentId);
                return (
                  <li
                    key={s.id}
                    className={`border-t border-[var(--border)] py-2.5 first:border-t-0 first:pt-0 ${s.enabled ? "" : "opacity-60"}`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      <span
                        aria-label={s.lastError ? "errored" : s.enabled ? "on" : "off"}
                        className="inline-block h-2 w-2 shrink-0"
                        style={{
                          background: s.lastError ? "var(--brand)" : s.enabled ? "var(--ai)" : "var(--border-strong)",
                        }}
                      />
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {agent ? (
                        <Link href={`/agents/${agent.slug}`} className="text-[var(--text-soft)] hover:text-[var(--brand)]">
                          {agent.name}
                        </Link>
                      ) : (
                        "Unknown agent"
                      )}{" "}
                      · {cadence(s)} · last {rel(s.lastRunAt, now).toLowerCase()}
                    </p>
                  </li>
                );
              })}
              {schedules.length > 5 && (
                <li className="border-t border-[var(--border)] pt-2.5 text-xs text-[var(--muted)]">
                  And {schedules.length - 5} more.
                </li>
              )}
            </ul>
          )}
        </section>

        <section className="panel p-5 md:col-span-2 md:p-6 lg:col-span-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="eyebrow">Tool servers</div>
            <Link href="/mcp" className="text-xs text-[var(--muted)] hover:text-[var(--brand)]">
              Manage →
            </Link>
          </div>
          {servers.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              None declared. Agents still have their own memory; add servers to reach live systems.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col">
              {servers.map((s) => {
                const users = usedBy(s.name);
                return (
                  <li key={s.name} className="border-t border-[var(--border)] first:border-t-0">
                    <Link href={`/mcp/${s.name}`} className="group flex items-start gap-3 py-2.5">
                      <span
                        aria-hidden
                        className="mt-1.5 inline-block h-2 w-2 shrink-0 border-2"
                        style={{ borderColor: s.enabled ? "var(--c-src)" : "var(--border-strong)" }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="truncate text-sm group-hover:text-[var(--brand)]">{s.label || s.name}</span>
                          <span className="eyebrow shrink-0">{s.enabled ? "On" : "Off"}</span>
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">
                          {users.length ? `Used by ${users.map((a) => a.name).join(", ")}` : "No agent uses it yet"}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

/** "▲ 4 on last week" — or nothing when there is no last week to compare with. */
function delta(now: number, before: number, fmt: (n: number) => string = String): string | undefined {
  if (before === 0 && now === 0) return undefined;
  if (before === 0) return "New this week";
  const d = now - before;
  if (Math.abs(d) < 1e-9) return "Same as last week";
  return `${d > 0 ? "▲" : "▼"} ${fmt(Math.abs(d))} on last week`;
}

function Stat({
  value,
  sub,
  label,
  node,
  outline,
  delta,
  href,
}: {
  value: string;
  sub?: string;
  label: string;
  node?: string;
  outline?: boolean;
  delta?: string;
  href: string;
}) {
  return (
    <Link href={href} className="group border-b border-[var(--border)] py-3.5 pr-4">
      <div className="metric flex items-baseline gap-2 text-3xl font-bold group-hover:text-[var(--brand)]">
        {node && (
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 shrink-0 self-center"
            style={outline ? { border: `2px solid ${node}` } : { background: node }}
          />
        )}
        {value}
        {sub && <span className="text-sm font-normal text-[var(--muted)]">{sub}</span>}
      </div>
      <div className="eyebrow mt-1">{label}</div>
      {delta && <div className="mt-1 text-xs text-[var(--muted)]">{delta}</div>}
    </Link>
  );
}

function Key({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="inline-block h-2 w-2" style={{ background: color }} />
      {children}
    </span>
  );
}

function Fig({ k, v, muted, big }: { k: string; v: string; muted?: boolean; big?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--muted)]">{k}</dt>
      <dd className={`metric font-bold ${big ? "text-2xl" : "text-lg"} ${muted ? "text-[var(--muted)]" : ""}`}>{v}</dd>
    </div>
  );
}

/**
 * Runs per day as stacked bars: failures in red on top of successes in blue.
 * Drawn with plain boxes rather than a chart library — fourteen bars need no
 * axes, and this renders on the server with the rest of the page.
 */
function Activity({ days }: { days: HubDay[] }) {
  const peak = Math.max(1, ...days.map((d) => d.runs));
  const H = 140;
  return (
    <div
      className="mt-5 grid items-end gap-1 sm:gap-1.5"
      style={{ gridTemplateColumns: `repeat(${Math.max(days.length, 1)}, minmax(0, 1fr))` }}
      role="img"
      aria-label={`Runs per day for ${days.length} days: ${days.map((d) => d.runs).join(", ")}`}
    >
      {days.map((d, i) => {
        const date = new Date(`${d.day}T00:00:00Z`);
        const ok = d.runs - d.failed;
        const today = i === days.length - 1;
        return (
          <div key={d.day} className="flex min-w-0 flex-col items-center gap-1.5" title={`${d.day}: ${d.runs} runs, ${d.failed} failed, ${money(d.spend)}`}>
            <span className="mono text-[10px] text-[var(--muted)]">{d.runs || ""}</span>
            <div className="flex w-full flex-col justify-end" style={{ height: H }}>
              {d.runs === 0 ? (
                <span className="block h-[2px] w-full bg-[var(--border-strong)]" />
              ) : (
                <>
                  {d.failed > 0 && <span className="block w-full bg-[var(--brand)]" style={{ height: (d.failed / peak) * H }} />}
                  {ok > 0 && <span className="block w-full bg-[var(--ai)]" style={{ height: (ok / peak) * H }} />}
                </>
              )}
            </div>
            <span className={`text-[10px] ${today ? "font-bold" : "text-[var(--muted)]"}`}>
              {i % 2 === (days.length - 1) % 2 ? DAYS[date.getUTCDay()].slice(0, 2) : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AgentLine({ agent: a, now }: { agent: AgentRosterRow; now: number }) {
  const peak = Math.max(1, ...(a.runsByDay ?? []));
  return (
    <li className="border-t border-[var(--border)] first:border-t-0">
      <Link href={`/agents/${a.slug}`} className={`group flex items-center gap-3 py-2.5 ${a.enabled ? "" : "opacity-60"}`}>
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0"
          style={{ background: a.failed7d ? "var(--brand)" : a.enabled ? "var(--ai)" : "var(--faint)" }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium group-hover:text-[var(--brand)]">{a.name}</span>
          <span className="block text-xs text-[var(--muted)]">
            {!a.enabled ? "Switched off" : a.lastRunAt ? `Last run ${rel(a.lastRunAt, now).toLowerCase()}` : "Never run"}
          </span>
        </span>
        <span className="flex items-end gap-[2px]" aria-label={`${a.runs7d} runs this week`}>
          {(a.runsByDay ?? []).map((n, i) => (
            <span
              key={i}
              className="inline-block w-1.5"
              style={{ height: n ? `${4 + (n / peak) * 16}px` : "2px", background: n ? "var(--ai)" : "var(--border-strong)" }}
            />
          ))}
        </span>
        <span className="mono w-6 text-right text-xs">{a.runs7d}</span>
      </Link>
    </li>
  );
}
