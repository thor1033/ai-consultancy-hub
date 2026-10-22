import Link from "next/link";
import { agentRoster, listMcpServers, type AgentRosterRow } from "@ai-hub/db";
import { money, rel } from "@/lib/format";

export const dynamic = "force-dynamic";

// The agents roster: every standing agent, what it is equipped with and how it
// has been doing this week. Read on the server per request — it is a view of
// the store, not an editor, so nothing here needs to run in the browser.

const serverList = (a: AgentRosterRow) =>
  (a.mcpServers ?? [])
    .map((e) => (typeof e === "string" ? e : String((e as { name?: unknown }).name ?? "")))
    .filter((n) => n && n !== "memory");

export default async function AgentsPage() {
  let roster: AgentRosterRow[] = [];
  let labels = new Map<string, string>();
  let error: string | null = null;
  try {
    const [rows, servers] = await Promise.all([agentRoster(), listMcpServers().catch(() => [])]);
    roster = rows;
    labels = new Map(servers.filter((s) => s.label).map((s) => [s.name, s.label]));
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load agents.";
  }

  const now = Date.now();
  const enabled = roster.filter((a) => a.enabled).length;
  const runs = roster.reduce((n, a) => n + a.runs7d, 0);
  const spend = roster.reduce((n, a) => n + a.spend7d, 0);
  const failed = roster.reduce((n, a) => n + a.failed7d, 0);
  const peak = Math.max(1, ...roster.flatMap((a) => a.runsByDay ?? []));

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow">Agents</div>
          <h1 className="mt-3 text-3xl md:text-4xl">Your standing agents.</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
            Named workers with their own brief, tools, knowledge and memory. Each one keeps what it learns between
            runs, and every skill it has becomes a tool in Claude Code.
          </p>
        </div>
        <Link href="/agents/new" className="btn-brand min-h-11">
          New agent
        </Link>
      </header>

      {error ? (
        <div className="panel notice-warning mt-6 p-4 text-sm text-[var(--warning)]">{error}</div>
      ) : (
        <>
          <div className="rule-heavy mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat value={`${enabled}`} sub={roster.length !== enabled ? `of ${roster.length}` : undefined} label="Agents on" />
            <Stat value={`${runs}`} label="Runs · 7 days" node="var(--ai)" />
            <Stat value={`${failed}`} label="Failed · 7 days" node={failed ? "var(--brand)" : undefined} />
            <Stat value={money(spend)} label="Spend · 7 days" />
            <Stat value={`${roster.reduce((n, a) => n + a.memoriesLoaded, 0)}`} label="Memories loaded" node="var(--c-mem)" />
            <Stat value={`${roster.reduce((n, a) => n + a.schedulesEnabled, 0)}`} label="Schedules on" />
          </div>

          {roster.length === 0 ? (
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
            <ul className="mt-6 flex flex-col gap-3">
              {roster.map((a) => (
                <AgentRow key={a.id} agent={a} labels={labels} now={now} peak={peak} />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function Stat({ value, sub, label, node }: { value: string; sub?: string; label: string; node?: string }) {
  return (
    <div className="border-b border-[var(--border)] py-3.5 pr-4">
      <div className="metric flex items-baseline gap-2 text-3xl font-bold">
        {node && <span className="inline-block h-2.5 w-2.5 shrink-0 self-center" style={{ background: node }} />}
        {value}
        {sub && <span className="text-sm font-normal text-[var(--muted)]">{sub}</span>}
      </div>
      <div className="eyebrow mt-1">{label}</div>
    </div>
  );
}

function AgentRow({
  agent: a,
  labels,
  now,
  peak,
}: {
  agent: AgentRosterRow;
  labels: Map<string, string>;
  now: number;
  peak: number;
}) {
  const servers = serverList(a);
  const health: { text: string; color: string }[] = [];
  if (!a.enabled) health.push({ text: "Switched off", color: "var(--faint)" });
  // Where it runs is worth a glance on the roster: a local agent is absent from
  // the hub's tool list and its schedules, which otherwise looks like a fault.
  if (a.placement === "local") health.push({ text: "Runs in Claude Code only", color: "var(--c-src)" });
  if (a.placement === "both") health.push({ text: "Hub and Claude Code", color: "var(--c-src)" });
  if (a.failed7d) health.push({ text: `${a.failed7d} failed run${a.failed7d === 1 ? "" : "s"} this week`, color: "var(--brand)" });
  if (a.scheduleError) health.push({ text: "A schedule errored", color: "var(--brand)" });
  if (!a.lastRunAt && a.enabled) health.push({ text: "Never run", color: "var(--text)" });
  if (a.memoriesLoaded + a.memoriesAside === 0 && a.enabled) health.push({ text: "Remembers nothing yet", color: "var(--faint)" });

  return (
    <li>
      <Link
        href={`/agents/${a.slug}`}
        className={`panel panel-hover group grid gap-x-8 gap-y-5 p-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_14rem] ${a.enabled ? "" : "opacity-70"}`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0"
              style={{ background: a.enabled ? "var(--ai)" : "var(--faint)" }}
            />
            <h2 className="text-xl transition-colors group-hover:text-[var(--brand)]">{a.name}</h2>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-[var(--text-soft)]">
            {a.description || <span className="text-[var(--muted)]">No description yet.</span>}
          </p>
          {health.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {health.map((h) => (
                <li key={h.text} className="flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-1.5 w-1.5" style={{ background: h.color }} />
                  {h.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4 lg:grid-cols-2">
          <Equip label="Memory" node={{ shape: "square", color: "var(--c-mem)" }}>
            {a.memoriesLoaded} loaded
            {a.memoriesAside > 0 && <span className="text-[var(--muted)]"> · {a.memoriesAside} aside</span>}
          </Equip>
          <Equip label="Skills" node={{ shape: "diamond", color: "var(--c-skill)" }}>
            {a.skills || <span className="text-[var(--muted)]">None</span>}
          </Equip>
          <Equip label="Tools" node={{ shape: "outline", color: "var(--c-src)" }}>
            {servers.length ? servers.map((n) => labels.get(n) ?? n).join(", ") : <span className="text-[var(--muted)]">Memory only</span>}
          </Equip>
          <Equip label="Knowledge">
            {a.knowledgeCollection ? <span className="mono text-xs">{a.knowledgeCollection}</span> : <span className="text-[var(--muted)]">None</span>}
          </Equip>
        </dl>

        <div className="flex flex-col gap-2 lg:items-end">
          <div className="flex items-end gap-[3px]" role="img" aria-label={`${a.runs7d} runs in the last 7 days`}>
            {(a.runsByDay ?? []).map((n, i) => (
              <span
                key={i}
                className="inline-block w-3"
                style={{
                  height: n ? `${6 + (n / peak) * 26}px` : "2px",
                  background: n ? "var(--ai)" : "var(--border-strong)",
                }}
              />
            ))}
          </div>
          <div className="text-xs text-[var(--muted)] lg:text-right">
            <span className="text-[var(--text)]">{a.runs7d}</span> run{a.runs7d === 1 ? "" : "s"} · {money(a.spend7d)} this week
          </div>
          <div className="text-xs text-[var(--muted)] lg:text-right">
            Last run: <span className="text-[var(--text-soft)]">{rel(a.lastRunAt, now, "Never run")}</span>
            {a.lastRunStatus === "failed" && <span className="text-[var(--danger)]"> · failed</span>}
          </div>
          {a.schedulesEnabled > 0 && (
            <div className="text-xs text-[var(--muted)] lg:text-right">
              {a.schedulesEnabled} schedule{a.schedulesEnabled === 1 ? "" : "s"} on
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}

function Equip({
  label,
  node,
  children,
}: {
  label: string;
  node?: { shape: "square" | "diamond" | "outline"; color: string };
  children: React.ReactNode;
}) {
  const style: React.CSSProperties | undefined = node
    ? node.shape === "outline"
      ? { width: 9, height: 9, border: `2px solid ${node.color}` }
      : { width: node.shape === "diamond" ? 7 : 9, height: node.shape === "diamond" ? 7 : 9, background: node.color, transform: node.shape === "diamond" ? "rotate(45deg)" : undefined }
    : undefined;
  return (
    <div className="min-w-0">
      <dt className="eyebrow flex items-center gap-1.5">
        {style && <span aria-hidden className="inline-block shrink-0" style={style} />}
        {label}
      </dt>
      <dd className="mt-1 break-words">{children}</dd>
    </div>
  );
}
