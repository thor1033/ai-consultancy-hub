import Link from "next/link";
import { notFound } from "next/navigation";
import { describeMcpServer, listRegisteredServers, type McpToolInfo } from "@/lib/mcpCatalog";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function McpDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;

  const servers = await listRegisteredServers().catch(() => []);
  const server = servers.find((s) => s.name === name);
  if (!server) notFound();

  // Introspecting connects to the child process — tolerate a server that won't start.
  let tools: McpToolInfo[] = [];
  let toolsError: string | null = null;
  try {
    tools = await describeMcpServer(name);
  } catch (e) {
    toolsError = e instanceof Error ? e.message : "Could not connect to this server.";
  }

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
          <span
            className={`chip ${server.enabled ? "text-[var(--positive)]" : "text-[var(--muted)]"}`}
          >
            <span
              className="dot"
              style={{ background: server.enabled ? "var(--positive)" : "var(--muted)", color: server.enabled ? "var(--positive)" : "var(--muted)" }}
            />
            {server.enabled ? "Enabled" : "Disabled"}
          </span>
        }
      />

      {/* Facts */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Fact label="Server id" value={server.name} mono />
        <Fact label="Tools" value={toolsError ? "—" : String(tools.length)} />
        <Fact
          label="Status"
          value={server.enabled ? "Enabled" : "Disabled"}
        />
      </div>

      {/* Tools */}
      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">
          Tools{!toolsError && <span className="ml-2 text-[var(--muted)]">{tools.length}</span>}
        </h2>

        {toolsError ? (
          <div className="panel border-l-2 border-l-[var(--warning)] p-4 text-sm text-[var(--warning)]">
            Couldn&apos;t introspect this server: {toolsError}
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
                  <code className="mono rounded bg-[var(--brand-soft)] px-2 py-0.5 text-sm text-[var(--brand-ink)]">
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
                        <span className="mono text-[0.7rem] text-[var(--brand-ink)]">{p.type}</span>
                        {p.required && (
                          <span className="text-[0.65rem] uppercase tracking-wide text-[var(--warning)]">
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
      </section>
    </main>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="panel p-4">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`mt-1 text-sm font-medium text-[var(--text)] ${mono ? "mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}
