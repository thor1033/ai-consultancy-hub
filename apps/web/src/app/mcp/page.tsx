import Link from "next/link";
import { Suspense } from "react";
import { headers } from "next/headers";
import { toolCallCounts, type ToolCallCount } from "@ai-hub/db";
import { countMcpTools } from "@/lib/mcpCatalog";
import { appBaseUrl } from "@/lib/baseUrl";
import { rel } from "@/lib/format";
import { viewContext } from "@/lib/viewServer";
import { sessionCan } from "@/lib/sessionPrincipal";
import { sealingStatus } from "@/lib/secretBox";
import { CopyLine } from "./CopyLine";
import { AddConnection } from "./AddConnection";
import { serverDirectory, type DirectoryEntry } from "./directory";

export const dynamic = "force-dynamic";

// What the agents can reach. One row per tool server — what it is, who uses
// it, how much, and whether it answers right now — then the two connections
// that are not in that list: each agent's own memory, and the hub itself,
// which is an MCP server for Claude Code and Claude.ai.
//
// The rows come from the database and paint at once. Whether a server answers
// needs a live connection, so that streams in behind Suspense per row: a server
// that is slow or down costs its own status, not the page.
export default async function McpOverviewPage() {
  let entries: DirectoryEntry[] = [];
  let roster: Awaited<ReturnType<typeof serverDirectory>>["roster"] = [];
  let error: string | null = null;
  try {
    ({ entries, roster } = await serverDirectory());
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load MCP servers.";
  }
  const calls = await toolCallCounts(7).catch(() => [] as ToolCallCount[]);

  const now = Date.now();
  const on = entries.filter((e) => e.enabled).length;
  const connected = roster.filter((a) => entries.some((e) => e.users.some((u) => u.slug === a.slug))).length;
  const runs = entries.reduce((n, e) => n + e.runs7d, 0);
  const callTotal = calls.reduce((n, c) => n + c.calls, 0);
  const memories = roster.reduce((n, a) => n + a.memoriesLoaded + a.memoriesAside, 0);
  const base = appBaseUrl(await headers());
  const hubUrl = `${base ?? ""}/api/mcp`;
  const agentsOn = roster.filter((a) => a.enabled);
  const skills = agentsOn.reduce((n, a) => n + a.skills, 0);
  // Below Expert this page is "Connections" (docs/views.md): the same rows,
  // without protocol names, tool prefixes or settings a person cannot change.
  const expert = (await viewContext()).view === "expert";
  // Adding a connection is an admin's (docs/connections.md).
  const canAdd = Boolean(await sessionCan("admin:manage"));
  const sealing = sealingStatus();

  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <header className="min-w-0">
        <div className="eyebrow">{expert ? "MCP servers" : "Connections"}</div>
        <h1 className="mt-3 text-3xl md:text-4xl">What your agents can reach.</h1>
        <p className="mt-2 max-w-2xl text-[var(--text-soft)]">
          Each server is a live connection — a project board, a mailbox — that an agent calls as tools while it works.
          Switch one off and it drops out of every run at once.
        </p>
      </header>

      {canAdd && (
        <div className="mt-6">
          <AddConnection sealing={sealing.ok ? { ok: true } : sealing} />
        </div>
      )}

      {error ? (
        <div className="panel notice-warning mt-6 p-4 text-sm text-[var(--warning)]">{error}</div>
      ) : (
        <>
          <div className="rule-heavy mt-6 grid grid-cols-2 lg:grid-cols-4">
            <Stat value={`${on}`} sub={on !== entries.length ? `of ${entries.length}` : undefined} label="Servers on" node="var(--c-src)" />
            <Stat value={`${connected}`} sub={`of ${roster.length}`} label="Agents connected" />
            <Stat value={`${runs}`} label="Runs connected · 7 days" node="var(--ai)" fill />
            <Stat value={`${callTotal}`} label="Tool calls · 7 days" />
          </div>

          {entries.length === 0 ? (
            <section className="panel mt-6 p-8 md:p-12">
              <div className="eyebrow">No servers yet</div>
              <h2 className="mt-3 max-w-2xl text-2xl">Agents can only remember for now.</h2>
              <p className="mt-3 max-w-2xl text-[var(--text-soft)]">
                {expert ? (
                  <>
                    Add one above, or declare a remote server in <span className="mono text-sm">HUB_REMOTE_MCP_SERVERS</span>; either
                    appears here, ready to give to an agent.
                  </>
                ) : canAdd ? (
                  "Connect your other systems — a CRM, a project board, a ticket queue — with Add a connection above. Once one is added, it shows here and can be given to an agent."
                ) : (
                  "Connections to your other systems — a project board, a mailbox — are added by whoever runs the hub. Once one is added, it shows here and can be given to an agent."
                )}
              </p>
            </section>
          ) : (
            <ul className="mt-6 flex flex-col gap-3">
              {entries.map((e) => (
                <ServerRow key={e.name} entry={e} now={now} expert={expert} />
              ))}
            </ul>
          )}

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
            <section className="panel flex min-w-0 flex-col p-5 md:p-6">
              <div className="flex items-baseline justify-between gap-2">
                <div className="eyebrow flex items-center gap-2">
                  <span aria-hidden className="inline-block h-2 w-2 bg-[var(--c-mem)]" />
                  Always attached · Memory
                </div>
                <Link href="/context" className="text-xs text-[var(--muted)] hover:text-[var(--brand)]">
                  Context →
                </Link>
              </div>
              <p className="mt-3 text-sm text-[var(--text-soft)]">
                {expert
                  ? "Every agent gets its own memory server, started for each run and scoped to that agent alone — one agent can never read another's memory by asking. It is not listed above because nobody chooses it."
                  : "Every agent has a memory of its own that no other agent can read. It is not listed above because nobody has to switch it on."}
              </p>
              <dl className="mt-auto grid grid-cols-2 gap-3 pt-4">
                <Fig k="Agents" v={`${roster.length}`} />
                <Fig k="Memories kept" v={`${memories}`} />
              </dl>
            </section>

            <section className="panel min-w-0 p-5 md:p-6">
              <div className="eyebrow flex items-center gap-2">
                <span aria-hidden className="inline-block h-2 w-2 bg-[var(--ai)]" />
                The hub is a server too
              </div>
              {!expert ? (
                <p className="mt-3 text-sm text-[var(--text-soft)]">
                  You can use the agents from Claude.ai too: in Claude.ai, open Settings → Connectors → Add custom connector, and
                  paste the address below. You sign in with your usual account; nothing secret is pasted anywhere.
                </p>
              ) : (
              <p className="mt-3 text-sm text-[var(--text-soft)]">
                Claude Code, Claude.ai and Cursor connect here and get every agent as a tool —{" "}
                <span className="mono text-xs">hub_agent_*</span> for {agentsOn.length} agent{agentsOn.length === 1 ? "" : "s"}
                {skills > 0 && (
                  <>
                    , <span className="mono text-xs">hub_skill_*</span> for {skills} skill{skills === 1 ? "" : "s"}
                  </>
                )}{" "}
                — plus knowledge search and agent memory. Sign-in is OAuth, so nothing secret goes in the config.
              </p>
              )}
              <div className="mt-4 flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-xs text-[var(--muted)]">Server URL</div>
                  <CopyLine text={hubUrl} label="server URL" />
                </div>
                {expert && (
                  <>
                    <div>
                      <div className="mb-1 text-xs text-[var(--muted)]">Claude Code</div>
                      <CopyLine text={`claude mcp add --transport http ai-hub ${hubUrl}`} label="Claude Code command" />
                    </div>
                    <p className="text-xs text-[var(--muted)]">
                      In Claude.ai: Settings → Connectors → Add custom connector, and paste the server URL.
                    </p>
                  </>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function ServerRow({ entry: e, now, expert }: { entry: DirectoryEntry; now: number; expert: boolean }) {
  return (
    <li>
      <Link
        href={`/mcp/${e.name}`}
        className={`panel panel-hover group grid gap-x-8 gap-y-4 p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_15rem] ${e.enabled ? "" : "opacity-70"}`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 border-2"
              style={{ borderColor: e.enabled ? "var(--c-src)" : "var(--faint)" }}
            />
            <h2 className="text-xl transition-colors group-hover:text-[var(--brand)]">{e.label}</h2>
            {!e.enabled && <span className="eyebrow">Off</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[var(--muted)]">
            {expert && (
              <>
                <span className="mono">{e.name}</span>
                <span>·</span>
              </>
            )}
            <span>
              {e.connection.kind === "remote"
                ? `Remote${e.connection.host ? ` · ${e.connection.host}` : ""}`
                : e.connection.kind === "local"
                  ? "Runs inside the hub"
                  : "Not declared on this deployment"}
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-[var(--text-soft)]">
            {e.description || <span className="text-[var(--muted)]">No description.</span>}
          </p>
        </div>

        <div className="min-w-0">
          <div className="eyebrow">Used by</div>
          <p className="mt-1 text-sm">
            {e.users.length ? (
              e.users.map((u, i) => (
                <span key={u.slug} className={u.enabled ? "" : "text-[var(--muted)]"}>
                  {i > 0 && ", "}
                  {u.name}
                </span>
              ))
            ) : (
              <span className="text-[var(--muted)]">No agent yet</span>
            )}
          </p>
        </div>

        <div className="flex flex-col gap-1.5 text-sm lg:items-end lg:text-right">
          <Suspense
            fallback={
              <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <span aria-hidden className="ctx-blink inline-block h-1.5 w-1.5 bg-[var(--muted)]" />
                Checking…
              </span>
            }
          >
            {e.connection.kind === "unknown" ? (
              <span className="flex items-center gap-1.5 text-xs text-[var(--warning)]">
                <span aria-hidden className="inline-block h-1.5 w-1.5 bg-[var(--warning)]" />
                Cannot be reached from here
              </span>
            ) : (
              <Liveness name={e.name} enabled={e.enabled} />
            )}
          </Suspense>
          <span className="text-xs text-[var(--muted)]">
            <span className="text-[var(--text)]">{e.runs7d}</span> run{e.runs7d === 1 ? "" : "s"} this week
          </span>
          <span className="text-xs text-[var(--muted)]">
            Last used: <span className="text-[var(--text-soft)]">{rel(e.lastUsedAt, now)}</span>
          </span>
        </div>
      </Link>
    </li>
  );
}

/** Connects, counts, closes — within the introspection deadline. */
async function Liveness({ name, enabled }: { name: string; enabled: boolean }) {
  const count = await countMcpTools(name);
  const up = count !== null;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5"
        style={{ background: up ? (enabled ? "var(--c-src)" : "var(--faint)") : "var(--brand)" }}
      />
      {up ? (
        <span>
          Answering · <span className="font-medium">{count}</span> tool{count === 1 ? "" : "s"}
        </span>
      ) : (
        <span className="text-[var(--danger)]">Not answering</span>
      )}
    </span>
  );
}

function Stat({
  value,
  sub,
  label,
  node,
  fill,
}: {
  value: string;
  sub?: string;
  label: string;
  node?: string;
  fill?: boolean;
}) {
  return (
    <div className="border-b border-[var(--border)] py-3.5 pr-4">
      <div className="metric flex items-baseline gap-2 text-3xl font-bold">
        {node && (
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 shrink-0 self-center"
            style={fill ? { background: node } : { border: `2px solid ${node}` }}
          />
        )}
        {value}
        {sub && <span className="text-sm font-normal text-[var(--muted)]">{sub}</span>}
      </div>
      <div className="eyebrow mt-1">{label}</div>
    </div>
  );
}

function Fig({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{k}</dt>
      <dd className="metric text-2xl font-bold">{v}</dd>
    </div>
  );
}
