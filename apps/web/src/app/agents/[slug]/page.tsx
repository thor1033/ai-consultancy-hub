import { notFound } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import {
  agentOrgLabels,
  agentRoster,
  getAgent,
  listAgentRuns,
  listMemories,
  listSchedules,
  listSkills,
  localActivity,
  type AgentRun,
  type Schedule,
  knowledgeLabel,
  knowledgeScope,
  runsOnHub,
  listHandoffs,
  listAgents,
  askedAgents,
} from "@ai-hub/db";
import { DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CEILING } from "@ai-hub/agent";
import { listCollections } from "@ai-hub/rag";
import { sessionCan, sessionKnowledgeAccess, sessionPrincipal } from "@/lib/sessionPrincipal";
import { DAYS, money, rel } from "@/lib/format";
import { AgentForm } from "../AgentForm";
import { toolCatalog } from "../catalog";
import { MODELS, agentToolName, serverMailboxes, serverNames, serverWritesAllowed, skillToolName } from "../models";
import { AgentTabs } from "./AgentTabs";
import { AgentChat } from "./AgentChat";
import { MemoryPanel } from "./MemoryPanel";
import { SkillsPanel } from "./SkillsPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { HandoffsPanel } from "./HandoffsPanel";
import { appBaseUrl } from "@/lib/baseUrl";
import { localAgentName, localSkillName, renderAgentFiles } from "@/lib/localAgents";

export const dynamic = "force-dynamic";

// One agent. The Overview answers "what is this, what does it start every run
// with, and how has it been doing" without a click; the other tabs are where
// you talk to it, prune what it remembers, give it skills and change it.

export default async function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const agent = await getAgent(slug);
  if (!agent) notFound();

  const named = serverNames(agent.mcpServers).filter((n) => n !== "memory");
  const mailboxes = serverMailboxes(agent.mcpServers);
  const writesAllowed = serverWritesAllowed(agent.mcpServers);
  // Everything below is display; a failure in one source must not take the
  // page (and with it the only way to fix the agent) down.
  const [memories, collections, skills, runs, schedules, roster, tools, canManage, activity, admin, viewer, orgLabels, handoffs, allAgents] =
    await Promise.all([
    listMemories(agent.id),
    sessionKnowledgeAccess()
      .then((access) => listCollections(access))
      .catch(() => [] as string[]),
    listSkills(agent.id).catch(() => []),
    listAgentRuns(agent.id, 10).catch(() => [] as AgentRun[]),
    listSchedules(agent.id).catch(() => [] as Schedule[]),
    agentRoster().catch(() => []),
    toolCatalog(named),
    sessionCan("agent:manage"),
    localActivity(agent.id).catch(() => null),
    // Moving an agent between the hub and Claude Code is admin-only
    // (actions.ts); the form greys the control out for everyone else.
    sessionCan("admin:manage"),
    // Who is looking, so the schedules panel can tell "yours" from "theirs".
    sessionPrincipal(),
    // Functions and owners already in use, as the form's suggestions.
    agentOrgLabels().catch(() => ({ functions: [], owners: [] })),
    listHandoffs(agent.id).catch(() => []),
    listAgents().catch(() => []),
  ]);
  const baseUrl = appBaseUrl(await headers()) ?? "https://hub.example.com";

  const stats = roster.find((r) => r.id === agent.id);
  const scope = knowledgeScope(agent);
  const now = Date.now();
  const loaded = memories.filter((m) => m.active);
  const aside = memories.length - loaded.length;
  const agentTools = tools.filter((t) => named.includes(t.name));
  const words = agent.instructions.trim() ? agent.instructions.trim().split(/\s+/).length : 0;
  const model = MODELS.find((m) => m.id === (agent.model ?? ""))?.label ?? agent.model;
  const liveSkills = skills.filter((s) => s.enabled);

  const overview = (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <section className="panel p-5 md:p-6">
          <div className="eyebrow">What every run starts with</div>
          <ol className="mt-4 flex flex-col">
            <Loadout node={{ shape: "square", color: "var(--c-rules)" }} label="Brief" href="#settings" action="Edit">
              {words ? (
                <>
                  <p className="line-clamp-3 text-sm text-[var(--text-soft)]">{agent.instructions.replace(/\s+/g, " ")}</p>
                  <span className="mt-1 block text-xs text-[var(--muted)]">{words} words</span>
                </>
              ) : (
                <span className="text-sm text-[var(--muted)]">No brief — it runs on its tools and memory alone.</span>
              )}
            </Loadout>
            <Loadout node={{ shape: "square", color: "var(--c-mem)" }} label="Memory" href="#memory" action="Review">
              <span className="text-sm">
                {loaded.length} loaded
                {aside > 0 && <span className="text-[var(--muted)]"> · {aside} set aside</span>}
              </span>
              {loaded.length > 0 && (
                <span className="mt-2 flex flex-wrap gap-1.5">
                  {loaded.slice(0, 8).map((m) => (
                    <span key={m.id} className="mono border border-[var(--border-strong)] px-1.5 py-0.5 text-xs">
                      {m.key}
                    </span>
                  ))}
                  {loaded.length > 8 && <span className="text-xs text-[var(--muted)]">+{loaded.length - 8} more</span>}
                </span>
              )}
            </Loadout>
            <Loadout node={{ shape: "outline", color: "var(--c-src)" }} label="Tools" href="#settings" action="Change">
              {agentTools.length ? (
                <span className="flex flex-col gap-1 text-sm">
                  {agentTools.map((t) => (
                    <span key={t.name}>
                      {t.label}
                      {mailboxes[t.name] && <span className="mono text-xs text-[var(--muted)]"> · {mailboxes[t.name]}</span>}
                      {!t.available && <span className="text-xs text-[var(--warning)]"> · not declared here, skipped</span>}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-sm text-[var(--muted)]">Memory only</span>
              )}
            </Loadout>
            <Loadout node={{ shape: "diamond", color: "var(--c-skill)" }} label="Skills" href="#skills" action="Manage">
              <span className="text-sm">
                {liveSkills.length ? liveSkills.map((s) => s.name).join(", ") : <span className="text-[var(--muted)]">None</span>}
              </span>
            </Loadout>
            <Loadout label="Knowledge" href="#settings" action="Change">
              {scope.kind === "collections" ? (
                <span className="mono text-sm">{knowledgeLabel(agent)}</span>
              ) : scope.kind === "all" ? (
                <span className="text-sm">Everything the asker may read</span>
              ) : (
                <span className="text-sm text-[var(--muted)]">None</span>
              )}
            </Loadout>
            <Loadout label="Model" href="#settings" action="Change" last>
              <span className="text-sm">
                {model}
                <span className="text-[var(--muted)]">
                  {" "}
                  · up to {agent.maxIterations ?? DEFAULT_MAX_ITERATIONS} tool rounds
                </span>
              </span>
            </Loadout>
          </ol>
        </section>

        <section className="panel p-5 md:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <div className="eyebrow">Recent runs</div>
            <span className="hidden text-xs text-[var(--muted)] sm:inline">Chats, scheduled runs and client calls</span>
          </div>
          {runs.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              Not run yet.{" "}
              <a href="#conversation" className="text-[var(--text)] underline underline-offset-2">
                Start a conversation
              </a>{" "}
              or call <span className="mono">{agentToolName(agent.slug)}</span> from a client.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col">
              {runs.map((r) => (
                <li key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 border-t border-[var(--border)] py-2.5">
                  <span
                    aria-label={r.status}
                    title={r.status}
                    className={`mt-1.5 inline-block h-2 w-2 ${r.status === "running" ? "ctx-blink" : ""}`}
                    style={{
                      background:
                        r.status === "failed" ? "var(--brand)" : "var(--ai)",
                    }}
                  />
                  <div className="min-w-0">
                    <Link
                      href={`/agents/${agent.slug}/runs/${r.id}`}
                      title="Where this run's time went"
                      className="block truncate text-sm hover:text-[var(--brand-ink)] hover:underline hover:underline-offset-2"
                    >
                      {r.prompt || <span className="text-[var(--muted)]">(no prompt)</span>}
                    </Link>
                    <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-[var(--muted)]">
                      {r.skill && (
                        <span className="inline-flex items-center gap-1 text-[var(--text-soft)]">
                          <span aria-hidden className="inline-block h-1.5 w-1.5 rotate-45 bg-[var(--c-skill)]" />
                          {r.skill}
                        </span>
                      )}
                      {r.costUsd !== null && <span>{money(r.costUsd)}</span>}
                      {r.latencyMs !== null && <span>{(r.latencyMs / 1000).toFixed(1)}s</span>}
                    </p>
                    {r.status === "failed" && r.error && (
                      <p className="mt-1 line-clamp-2 text-xs text-[var(--danger)]">{r.error}</p>
                    )}
                  </div>
                  <span className="whitespace-nowrap text-xs text-[var(--muted)]">{rel(r.at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <section className="panel p-5 md:p-6">
          <div className="eyebrow">This week</div>
          <Week days={stats?.runsByDay ?? []} now={now} />
          <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-[var(--muted)]">Runs</dt>
              <dd className="metric text-xl font-bold">{stats?.runs7d ?? 0}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">Failed</dt>
              <dd className={`metric text-xl font-bold ${stats?.failed7d ? "text-[var(--brand)]" : ""}`}>{stats?.failed7d ?? 0}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">Spend</dt>
              <dd className="metric text-xl font-bold">{money(stats?.spend7d ?? 0)}</dd>
            </div>
          </dl>
        </section>

        <section className="panel p-5 md:p-6">
          <div className="eyebrow">Reach it from a client</div>
          {agent.placement !== "local" && (
            <>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Every client connected to the hub — Claude Code, Claude.ai, Cursor — lists these tools.
              </p>
              <ul className="mt-3 flex flex-col gap-1.5">
                <li className="inset mono flex items-center gap-2 break-all px-3 py-2 text-xs">
                  <span aria-hidden className="inline-block h-2 w-2 shrink-0 bg-[var(--ai)]" />
                  {agentToolName(agent.slug)}
                </li>
                {liveSkills.map((s) => (
                  <li key={s.id} className="inset mono flex items-center gap-2 break-all px-3 py-2 text-xs">
                    <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rotate-45 bg-[var(--c-skill)]" />
                    {skillToolName(s.slug)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {agent.placement !== "hub" && (
            <>
              <p className={`text-sm text-[var(--muted)] ${agent.placement === "local" ? "mt-2" : "mt-4"}`}>
                In Claude Code it is a sub-agent, synced at session start. Its tools, memory and knowledge still
                come through the hub.
              </p>
              <ul className="mt-3 flex flex-col gap-1.5">
                <li className="inset mono flex items-center gap-2 break-all px-3 py-2 text-xs">
                  <span aria-hidden className="inline-block h-2 w-2 shrink-0 border-2" style={{ borderColor: "var(--c-src)" }} />
                  {localAgentName(agent.slug)}
                </li>
                {liveSkills.map((s) => (
                  <li key={s.id} className="inset mono flex items-center gap-2 break-all px-3 py-2 text-xs">
                    <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rotate-45 bg-[var(--c-skill)]" />
                    /{localSkillName(s.slug)}
                  </li>
                ))}
              </ul>
              {activity && (
                <p className="mt-3 text-xs text-[var(--muted)]">
                  Local use, 30 days: {activity.calls} tool {activity.calls === 1 ? "call" : "calls"}
                  {activity.failed > 0 && <span className="text-[var(--warning)]"> ({activity.failed} refused or failed)</span>}
                  {" "}by {activity.people} {activity.people === 1 ? "person" : "people"}
                  {activity.lastAt && <> · last {rel(activity.lastAt, now).toLowerCase()}</>}
                </p>
              )}
            </>
          )}
          {!agent.enabled && (
            <p className="mt-3 text-xs text-[var(--warning)]">Switched off — clients do not see these right now.</p>
          )}
        </section>

        <SchedulesPanel
          agentId={agent.id}
          skills={skills}
          initial={schedules}
          viewerId={viewer?.id ?? null}
          isAdmin={Boolean(admin)}
          canSchedule={runsOnHub(agent.placement)}
          timezone={process.env.HUB_TIMEZONE?.trim() || "UTC"}
        />
      </div>
    </div>
  );

  const settings = (
    <>
      {!canManage && (
        <div className="panel notice-warning mb-6 p-4 text-sm text-[var(--warning)]">
          Only an admin can change agents. You can look, but saving will be refused.
        </div>
      )}
      <AgentForm
        initial={{
          id: agent.id,
          slug: agent.slug,
          name: agent.name,
          description: agent.description,
          instructions: agent.instructions,
          model: agent.model ?? "",
          knowledge: scope.kind === "collections" ? "selected" : scope.kind,
          knowledgeCollections: agent.knowledgeCollections,
          // Kept as a string so the box can be emptied back to "use the default".
          maxIterations: agent.maxIterations === null ? "" : String(agent.maxIterations),
          servers: named,
          enabled: agent.enabled,
          placement: agent.placement,
          functionName: agent.functionName,
          owner: agent.owner,
          mailboxes,
          writesAllowed,
          keepsMemory: agent.keepsMemory,
          asks: askedAgents(agent.mcpServers),
        }}
        agents={allAgents.map((a) => ({ slug: a.slug, name: a.name, description: a.description }))}
        functions={orgLabels.functions}
        owners={orgLabels.owners}
        tools={tools}
        collections={collections}
        defaultMaxIterations={DEFAULT_MAX_ITERATIONS}
        maxIterationsCeiling={MAX_ITERATIONS_CEILING}
        canSetPlacement={Boolean(admin)}
        canAllowWrites={Boolean(admin)}
        localFiles={renderAgentFiles(agent, skills, baseUrl)}
      />
    </>
  );

  const health: { text: string; color: string }[] = [];
  if (stats?.failed7d) health.push({ text: `${stats.failed7d} failed this week`, color: "var(--brand)" });
  if (stats?.scheduleError) health.push({ text: "A schedule errored", color: "var(--brand)" });

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← Agents
      </Link>

      <header className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5"
              style={{ background: agent.enabled ? "var(--ai)" : "var(--faint)" }}
            />
            {agent.enabled ? "Agent · On" : "Agent · Switched off"}
            {agent.placement !== "hub" && (
              <span>· {agent.placement === "local" ? "Runs in Claude Code" : "Hub and Claude Code"}</span>
            )}
            {agent.pattern && <span>· {agent.pattern.role} of “{agent.pattern.instance}”</span>}
            {!agent.keepsMemory && <span>· No memory</span>}
            <span className="mono normal-case tracking-normal text-[var(--faint)]">{agent.slug}</span>
          </div>
          <h1 className="mt-3 text-3xl md:text-4xl">{agent.name}</h1>
          <p className="mt-2 max-w-2xl text-[var(--text-soft)]">
            {agent.description || <span className="text-[var(--muted)]">No description yet.</span>}
          </p>
          {health.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-4 text-xs">
              {health.map((h) => (
                <li key={h.text} className="flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-1.5 w-1.5" style={{ background: h.color }} />
                  {h.text}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex gap-2">
          <a href="#settings" className="btn min-h-11">
            Settings
          </a>
          {agent.enabled && (
            <a href="#conversation" className="btn-brand min-h-11">
              Talk to {agent.name.split(" ")[0]}
            </a>
          )}
        </div>
      </header>

      <div className="rule-heavy mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat value={`${stats?.runs7d ?? 0}`} label="Runs · 7 days" node="var(--ai)" />
        <Stat value={money(stats?.spend7d ?? 0)} label="Spend · 7 days" />
        <Stat value={rel(stats?.lastRunAt ?? null, now)} label="Last run" small />
        <Stat value={`${loaded.length}`} label="Memories loaded" node="var(--c-mem)" />
        <Stat value={`${liveSkills.length}`} label="Skills" node="var(--c-skill)" diamond />
        <Stat value={`${stats?.schedulesEnabled ?? 0}`} label="Schedules on" />
      </div>

      <AgentTabs
        tabs={[
          { id: "overview", label: "Overview", content: overview },
          {
            id: "conversation",
            label: "Conversation",
            content:
              agent.placement === "local" ? (
                <div className="panel p-5 text-sm text-[var(--text-soft)]">
                  {agent.name} runs in Claude Code, as the <span className="mono">{localAgentName(agent.slug)}</span>{" "}
                  sub-agent, so the hub does not run it here. Set it to <strong>Hub</strong> or <strong>Both</strong> under{" "}
                  <a href="#settings" className="underline underline-offset-2">
                    Settings
                  </a>{" "}
                  to talk to it in this console.
                </div>
              ) : (
                <AgentChat slug={agent.slug} name={agent.name} enabled={agent.enabled} />
              ),
          },
          {
            id: "memory",
            label: "Memory",
            count: memories.length,
            content: <MemoryPanel agentId={agent.id} name={agent.name} memories={memories} />,
          },
          {
            id: "skills",
            label: "Skills",
            count: skills.length,
            content: <SkillsPanel agentId={agent.id} agentSlug={agent.slug} initial={skills} />,
          },
          {
            id: "handoffs",
            label: "Hand-offs",
            count: handoffs.length,
            content: (
              <HandoffsPanel
                agentId={agent.id}
                agentName={agent.name}
                initial={handoffs}
                skills={skills}
                agents={allAgents.map((a) => ({ id: a.id, slug: a.slug, name: a.name }))}
                canManage={Boolean(canManage)}
              />
            ),
          },
          { id: "settings", label: "Settings", content: settings },
        ]}
      />
    </main>
  );
}

function Stat({
  value,
  label,
  node,
  diamond,
  small,
}: {
  value: string;
  label: string;
  node?: string;
  diamond?: boolean;
  small?: boolean;
}) {
  return (
    <div className="border-b border-[var(--border)] py-3.5 pr-4">
      <div className={`metric flex items-baseline gap-2 font-bold ${small ? "text-xl leading-9" : "text-3xl"}`}>
        {node && (
          <span
            aria-hidden
            className={`inline-block shrink-0 self-center ${diamond ? "h-2 w-2 rotate-45" : "h-2.5 w-2.5"}`}
            style={{ background: node }}
          />
        )}
        {value}
      </div>
      <div className="eyebrow mt-1">{label}</div>
    </div>
  );
}

function Loadout({
  label,
  node,
  href,
  action,
  last,
  children,
}: {
  label: string;
  node?: { shape: "square" | "diamond" | "outline"; color: string };
  href: string;
  action: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  const style: React.CSSProperties = !node
    ? { width: 9, height: 9, border: "1px solid var(--border-strong)" }
    : node.shape === "outline"
      ? { width: 9, height: 9, border: `2px solid ${node.color}` }
      : node.shape === "diamond"
        ? { width: 7, height: 7, background: node.color, transform: "rotate(45deg)" }
        : { width: 9, height: 9, background: node.color };
  return (
    <li className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
      {/* The spine: a run reads these top to bottom before it does anything. */}
      {!last && <span aria-hidden className="absolute bottom-0 left-[0.6rem] top-4 w-px bg-[var(--border-strong)]" />}
      <span className="flex h-5 items-center justify-center">
        <span aria-hidden className="relative inline-block bg-[var(--panel)]" style={style} />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="eyebrow">{label}</span>
          <a href={href} className="text-xs text-[var(--muted)] hover:text-[var(--brand)]">
            {action}
          </a>
        </div>
        <div className="mt-1">{children}</div>
      </div>
    </li>
  );
}

function Week({ days, now }: { days: number[]; now: number }) {
  const peak = Math.max(1, ...days);
  return (
    <div className="mt-4 grid grid-cols-7 items-end gap-1.5" role="img" aria-label={`Runs per day: ${days.join(", ")}`}>
      {days.map((n, i) => {
        const day = new Date(now - (days.length - 1 - i) * 86400000);
        return (
          <div key={i} className="flex flex-col items-center gap-1.5">
            <span className="mono text-[10px] text-[var(--muted)]">{n || ""}</span>
            <span
              className="block w-full"
              style={{ height: n ? `${8 + (n / peak) * 56}px` : "2px", background: n ? "var(--ai)" : "var(--border-strong)" }}
            />
            <span className={`text-[10px] ${i === days.length - 1 ? "font-bold" : "text-[var(--muted)]"}`}>
              {DAYS[day.getUTCDay()].slice(0, 2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
