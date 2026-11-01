import Link from "next/link";
import { Suspense, cache } from "react";
import { notFound } from "next/navigation";
import { listHubConnections, listServerRuns, toolCallCounts, type ServerRun, type ToolCallCount } from "@ai-hub/db";
import { describeMcpServer, type McpToolInfo } from "@/lib/mcpCatalog";
import { sessionCan, sessionPrincipal } from "@/lib/sessionPrincipal";
import { rel } from "@/lib/format";
import { serverDirectory } from "../directory";
import { ServerSwitch } from "../ServerSwitch";
import { ToolList, type ToolRow } from "./ToolList";
import { ConnectionSettings } from "./ConnectionSettings";
import { hubRemoteProblem } from "@ai-hub/mcp";
import { hiddenPromptLabel, privateRun } from "@/lib/runPrivacy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One tool server: what it is, whether it answers, which agents depend on it,
// and every tool it offers with how often each is actually called.

// One introspection per request, shared by the stats and the tool list below:
// `cache` dedupes the call within a render, so two Suspense islands do not mean
// two child processes.
const describe = cache(async (name: string) => {
  try {
    return { tools: await describeMcpServer(name), error: null as string | null };
  } catch (e) {
    return {
      tools: [] as McpToolInfo[],
      error: e instanceof Error ? e.message : "Could not connect to this server.",
    };
  }
});

const usage30 = cache(() => toolCallCounts(30).catch(() => [] as ToolCallCount[]));

export default async function McpDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const { entries } = await serverDirectory().catch(() => ({ entries: [] }));
  const server = entries.find((s) => s.name === name);
  if (!server) notFound();

  const [runRows, canManage, me] = await Promise.all([
    listServerRuns(name, 8).catch(() => [] as ServerRun[]),
    sessionCan("admin:manage"),
    sessionPrincipal(),
  ]);
  // Other people's prompts are not shown (lib/runPrivacy.ts).
  const runs = runRows.map((r) => privateRun(r, { id: me?.id ?? null, admin: Boolean(canManage) }));
  // A connection added on the Connections page can be changed or removed here.
  // Only whether it has a token is read; the token itself never leaves the server.
  // Looked up by row, not by the registry: one whose token no longer opens is
  // out of the registry, and this is where it gets fixed.
  const added = canManage ? ((await listHubConnections().catch(() => [])).find((r) => r.name === name) ?? null) : null;
  const problem = added ? hubRemoteProblem(name) : null;
  const now = Date.now();
  const c = server.connection;

  // The registry facts render at once; introspecting the server (starting the
  // child process or calling the remote) streams in behind Suspense, so a server
  // that will not start costs its tool list, not the page.
  return (
    <main className="mx-auto max-w-[85rem] px-5 py-7 lg:px-8">
      <Link href="/mcp" className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← MCP servers
      </Link>

      <header className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow flex flex-wrap items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 border-2"
              style={{ borderColor: server.enabled ? "var(--c-src)" : "var(--faint)" }}
            />
            {server.enabled ? "MCP server · On" : "MCP server · Switched off"}
            <span className="mono normal-case tracking-normal text-[var(--faint)]">{server.name}</span>
          </div>
          <h1 className="mt-3 text-3xl md:text-4xl">{server.label}</h1>
          <p className="mt-2 max-w-2xl text-[var(--text-soft)]">
            {server.description || <span className="text-[var(--muted)]">No description.</span>}
          </p>
        </div>
        {server.inRegistry && canManage && (
          <ServerSwitch name={server.name} enabled={server.enabled} users={server.users.filter((u) => u.enabled).map((u) => u.name)} />
        )}
      </header>

      {problem && (
        <div role="alert" className="panel notice-danger mt-6 p-4 text-sm text-[var(--danger)]">
          This connection cannot be used: {problem}.
        </div>
      )}

      {!server.enabled && (
        <div className="panel notice-warning mt-6 p-4 text-sm">
          Switched off: every run skips this server, so{" "}
          {server.users.length ? server.users.map((u) => u.name).join(", ") : "no agent"} cannot use its tools until it is
          back on.
        </div>
      )}

      <div className="rule-heavy mt-6 grid grid-cols-2 lg:grid-cols-4">
        {c.kind === "unknown" ? (
          <>
            <Stat value="—" label="Tools · not declared" />
            <Stat value="—" label="Tool calls · 30 days" />
          </>
        ) : (
          <Suspense fallback={<Stat value="…" label="Tools" />}>
            <ToolStats name={name} />
          </Suspense>
        )}
        <Stat value={`${server.runs7d}`} label="Runs connected · 7 days" />
        <Stat value={rel(server.lastUsedAt, now)} label="Last used" small />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="min-w-0">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-lg">Tools</h2>
            <span className="text-xs text-[var(--muted)]">As the model sees them · calls over 30 days</span>
          </div>
          <Suspense
            fallback={
              <div className="panel flex items-center gap-2 p-6 text-sm text-[var(--muted)]">
                <span aria-hidden className="ctx-blink inline-block h-2 w-2 bg-[var(--c-src)]" />
                Connecting to {server.label}…
              </div>
            }
          >
            {c.kind === "unknown" ? (
              <div className="panel notice-warning p-5 text-sm">
                This deployment does not declare <span className="mono">{server.name}</span> in{" "}
                <span className="mono">HUB_REMOTE_MCP_SERVERS</span>, and it was not added on the Connections page (or its
                saved address or token can no longer be read), so the hub cannot connect to it and every run skips it.
              </div>
            ) : (
              <ServerTools name={name} now={now} />
            )}
          </Suspense>
        </section>

        <div className="flex min-w-0 flex-col gap-6">
          {added && (
            <ConnectionSettings
              name={name}
              label={added.label}
              description={added.description}
              host={server.connection.host}
              hasToken={Boolean(added.tokenSealed)}
              users={server.users.filter((u) => u.enabled).map((u) => u.name)}
            />
          )}
          <section className="panel p-5 md:p-6">
            <div className="eyebrow">Used by</div>
            {server.users.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--muted)]">
                No agent has it yet. Give it to one under the agent&apos;s Settings → What it may use.
              </p>
            ) : (
              <ul className="mt-3 flex flex-col">
                {server.users.map((u) => (
                  <li key={u.slug} className="border-t border-[var(--border)] first:border-t-0">
                    <Link href={`/agents/${u.slug}`} className="group flex items-center gap-2.5 py-2.5 text-sm">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2"
                        style={{ background: u.enabled ? "var(--ai)" : "var(--faint)" }}
                      />
                      <span className="flex-1 group-hover:text-[var(--brand)]">{u.name}</span>
                      {!u.enabled && <span className="eyebrow">Off</span>}
                      <span aria-hidden className="text-[var(--muted)] group-hover:text-[var(--brand)]">
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel p-5 md:p-6">
            <div className="eyebrow">Connection</div>
            <dl className="mt-3 flex flex-col text-sm">
              <Row k="Runs">
                {c.kind === "remote" ? "Remote, over HTTP" : c.kind === "local" ? "Inside the hub" : "Not declared here"}
              </Row>
              {c.kind === "remote" && (
                <>
                  <Row k="Host">
                    <span className="mono text-xs">{c.host ?? "Unreadable URL"}</span>
                  </Row>
                  <Row k="Credentials">
                    {c.authConfigured ? "Configured" : <span className="text-[var(--warning)]">None set</span>}
                  </Row>
                </>
              )}
              <Row k="Kill switch">
                {server.inRegistry ? (server.enabled ? "On" : "Off") : <span className="text-[var(--muted)]">Not in the registry</span>}
              </Row>
            </dl>
            {c.kind === "remote" && (
              <p className="mt-3 text-xs text-[var(--muted)]">
                Declared in <span className="mono">HUB_REMOTE_MCP_SERVERS</span>. The key lives in the deployment&apos;s
                secrets, never here.
              </p>
            )}
            {c.kind === "unknown" && (
              <p className="mt-3 text-xs text-[var(--warning)]">
                This deployment cannot start it, so every run skips it even though it is listed.
              </p>
            )}
          </section>

          <section className="panel p-5 md:p-6">
            <div className="eyebrow">Recent runs</div>
            {runs.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--muted)]">No run has connected to it yet.</p>
            ) : (
              <ul className="mt-3 flex flex-col">
                {runs.map((r) => (
                  <li key={r.id} className="border-t border-[var(--border)] first:border-t-0">
                    <Link
                      href={r.agentSlug ? `/agents/${r.agentSlug}` : "/agents"}
                      className="group grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 py-2.5"
                    >
                      <span
                        aria-label={r.status}
                        className="mt-1.5 inline-block h-2 w-2"
                        style={{ background: r.status === "failed" ? "var(--brand)" : "var(--ai)" }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm group-hover:text-[var(--brand)]">{r.prompt || (r.promptHidden ? <span className="text-[var(--muted)]">{hiddenPromptLabel(r)}</span> : <span className="text-[var(--muted)]">(no prompt)</span>)}</span>
                        <span className="block truncate text-xs text-[var(--muted)]">
                          <span className="text-[var(--text-soft)]">{r.agentName ?? "Workbench"}</span>
                          {r.toolsUsed.length > 0 && ` · ${[...new Set(r.toolsUsed)].join(", ")}`}
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-xs text-[var(--muted)]">{rel(r.at, now)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

async function ToolStats({ name }: { name: string }) {
  const [{ tools, error }, counts] = await Promise.all([describe(name), usage30()]);
  const mine = new Set(tools.map((t) => t.name));
  const calls = counts.filter((c) => mine.has(c.tool)).reduce((n, c) => n + c.calls, 0);
  return (
    <>
      <Stat value={error ? "—" : `${tools.length}`} label={error ? "Tools · not answering" : "Tools"} danger={Boolean(error)} />
      <Stat value={error ? "—" : `${calls}`} label="Tool calls · 30 days" node="var(--ai)" />
    </>
  );
}

async function ServerTools({ name, now }: { name: string; now: number }) {
  const [{ tools, error }, counts] = await Promise.all([describe(name), usage30()]);
  if (error) {
    return (
      <div className="panel notice-danger p-5 text-sm">
        <p className="font-medium text-[var(--danger)]">It did not answer.</p>
        <p className="mt-1 text-[var(--text-soft)]">{error}</p>
        <p className="mt-2 text-xs text-[var(--muted)]">
          While it is down, runs by agents that use it fail with this error rather than go ahead without it. Reload to
          try again.
        </p>
      </div>
    );
  }
  if (tools.length === 0) {
    return <div className="panel p-6 text-sm text-[var(--muted)]">It answered, but offers no tools.</div>;
  }
  const byTool = new Map(counts.map((c) => [c.tool, c]));
  const rows: ToolRow[] = tools.map((t) => {
    const u = byTool.get(t.name);
    return {
      ...t,
      calls: u?.calls ?? 0,
      usage: u ? `${u.calls} call${u.calls === 1 ? "" : "s"} · last ${rel(u.lastAt, now).toLowerCase()}` : "Not called in 30 days",
    };
  });
  return <ToolList tools={rows} />;
}

function Stat({
  value,
  label,
  node,
  small,
  danger,
}: {
  value: string;
  label: string;
  node?: string;
  small?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="border-b border-[var(--border)] py-3.5 pr-4">
      <div
        className={`metric flex items-baseline gap-2 font-bold ${small ? "text-xl leading-9" : "text-3xl"} ${danger ? "text-[var(--danger)]" : ""}`}
      >
        {node && <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 self-center" style={{ background: node }} />}
        {value}
      </div>
      <div className="eyebrow mt-1">{label}</div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-t border-[var(--border)] py-2 first:border-t-0">
      <dt className="shrink-0 text-[var(--muted)]">{k}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
