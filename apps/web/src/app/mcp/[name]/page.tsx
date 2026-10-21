import Link from "next/link";
import { Suspense, cache } from "react";
import { notFound } from "next/navigation";
import { describeMcpServer, listRegisteredServers, type McpToolInfo } from "@/lib/mcpCatalog";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One introspection per request, shared by the fact card and the tool list
// below: `cache` dedupes the call within a render, so two Suspense islands do
// not mean two child processes.
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

export default async function McpDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;

  const servers = await listRegisteredServers().catch(() => []);
  const server = servers.find((s) => s.name === name);
  if (!server) notFound();

  // The registry facts render at once; introspecting the server (connecting to
  // the child process or the remote) streams in behind Suspense, so a server
  // that will not start costs its tool list, not the page.
  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <Link href="/mcp" className="chip mb-5">
        ← Tool servers
      </Link>

      <PageHeader
        eyebrow="MCP server"
        title={server.label || server.name}
        subtitle={server.description || undefined}
        actions={
          <span className={`chip ${server.enabled ? "text-[var(--text)]" : "text-[var(--muted)]"}`}>
            <span
              className="dot"
              style={{ background: server.enabled ? "var(--ai)" : "var(--faint)" }}
            />
            {server.enabled ? "Enabled" : "Disabled"}
          </span>
        }
      />

      {/* Facts */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Fact label="Server id" value={server.name} mono />
        <Fact
          label="Tools"
          value={
            <Suspense fallback="…">
              <ToolCountFact name={name} />
            </Suspense>
          }
        />
        <Fact label="Status" value={server.enabled ? "Enabled" : "Disabled"} />
      </div>

      {/* Tools */}
      <section className="mt-6">
        <Suspense fallback={<ToolsPending />}>
          <ServerTools name={name} />
        </Suspense>
      </section>
    </main>
  );
}

async function ToolCountFact({ name }: { name: string }) {
  const { tools, error } = await describe(name);
  return <>{error ? "—" : String(tools.length)}</>;
}

function ToolsPending() {
  return (
    <>
      <h2 className="mb-3 text-sm font-semibold">Tools</h2>
      <div className="panel p-6 text-sm text-[var(--muted)]">Connecting to the server…</div>
    </>
  );
}

async function ServerTools({ name }: { name: string }) {
  const { tools, error } = await describe(name);
  return (
    <>
      <h2 className="mb-3 text-sm font-semibold">
        Tools{!error && <span className="ml-2 text-[var(--muted)]">{tools.length}</span>}
      </h2>

      {error ? (
        <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">
          Couldn&apos;t introspect this server: {error}
        </div>
      ) : tools.length === 0 ? (
        <div className="panel p-6 text-center text-sm text-[var(--muted)]">
          This server exposes no tools.
        </div>
      ) : (
        <div className="space-y-3">
          {tools.map((t) => (
            <div key={t.name} className="panel p-5">
              <div className="flex flex-wrap items-center gap-2">
                <code className="mono bg-[var(--brand-soft)] px-2 py-0.5 text-sm text-[var(--text-soft)]">
                  {t.name}
                </code>
                <span className="text-xs text-[var(--muted)]">
                  {t.params.length} param{t.params.length === 1 ? "" : "s"}
                </span>
              </div>
              {t.description && (
                <p className="mt-2 text-sm text-[var(--text-soft)]">{t.description}</p>
              )}
              {t.params.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {t.params.map((p) => (
                    <div key={p.name} className="inset flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
                      <code className="mono text-sm text-[var(--text)]">{p.name}</code>
                      <span className="mono text-[0.7rem] text-[var(--text-soft)]">{p.type}</span>
                      {p.required && (
                        <span className="text-[0.65rem] uppercase tracking-[0.18em] text-[var(--warning)]">
                          required
                        </span>
                      )}
                      {p.description && (
                        <span className="w-full text-xs text-[var(--muted)]">{p.description}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="panel p-4">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`mt-1 text-sm font-medium text-[var(--text)] ${mono ? "mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}
