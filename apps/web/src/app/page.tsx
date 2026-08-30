import Link from "next/link";
import { listAgents, listSessions, type SessionSummary } from "@ai-hub/db";
import { listDocuments, embedderStatus } from "@ai-hub/rag";
import { listRegisteredServers } from "@/lib/mcpCatalog";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

// The overview. Every panel here answers one question about the running hub —
// who is working, what it knows, what it can reach — rather than reporting a
// number the hub computed about itself.

function relative(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function OverviewPage() {
  // Each source is read independently: an empty knowledge base or an MCP server
  // that will not start should cost you that panel, not the whole page.
  const [agents, docs, servers, sessions] = await Promise.all([
    listAgents().catch(() => []),
    listDocuments().catch(() => []),
    listRegisteredServers().catch(() => []),
    listSessions(5).catch(() => [] as SessionSummary[]),
  ]);

  const embedder = embedderStatus();
  const chunks = docs.reduce((n, d) => n + d.chunkCount, 0);
  const enabledServers = servers.filter((s) => s.enabled).length;

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Overview"
        title="AI Hub"
        subtitle="Standing agents, the knowledge they draw on, and the tool servers they can reach."
      />

      {!embedder.production && (
        <div className="panel mb-6 border-l-2 border-l-[var(--danger)] p-4">
          <p className="text-sm text-[var(--text)]">
            Embeddings are running on <code>{embedder.name}</code>, the development
            fallback.
          </p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Retrieval will return confident nonsense rather than failing. Set{" "}
            <code>VOYAGE_API_KEY</code> and re-index to fix it.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Agents" value={String(agents.length)} href="/agents" />
        <Stat
          label="Documents indexed"
          value={String(docs.length)}
          note={`${chunks} chunk${chunks === 1 ? "" : "s"}`}
          href="/knowledge"
        />
        <Stat
          label="Tool servers"
          value={String(servers.length)}
          note={`${enabledServers} enabled`}
          href="/mcp"
        />
      </div>

      <section className="mt-8">
        <SectionHeading title="Agents" href="/agents" />
        {agents.length === 0 ? (
          <Empty>
            No agents yet. An agent is a standing worker with its own
            instructions, tools and durable memory.
          </Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((a) => (
              <Link
                key={a.id}
                href={`/agents/${a.slug}`}
                className="panel panel-hover group p-5"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{a.name}</h3>
                  <span
                    className="dot"
                    style={{
                      color: a.enabled ? "var(--positive)" : "var(--muted)",
                      background: a.enabled ? "var(--positive)" : "var(--muted)",
                    }}
                  />
                </div>
                <div className="mono mt-0.5 text-xs text-[var(--muted)]">{a.slug}</div>
                <p className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">
                  {a.description || "No description."}
                </p>
                <div className="mt-4 flex items-center justify-between text-xs">
                  <span className="mono rounded border border-[var(--border)] bg-[var(--panel-inset)] px-1.5 py-0.5 text-[var(--brand-ink)]">
                    {a.memoryCount} memor{a.memoryCount === 1 ? "y" : "ies"}
                  </span>
                  <span className="text-[var(--muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--brand-ink)]">
                    Open →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <SectionHeading title="Recent activity" />
        {sessions.length === 0 ? (
          <Empty>No agent runs recorded yet.</Empty>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="panel p-4">
                <div className="flex items-baseline justify-between gap-4">
                  <p className="line-clamp-1 text-sm text-[var(--text)]">{s.prompt}</p>
                  <span className="mono shrink-0 text-xs text-[var(--muted)]">
                    {relative(s.createdAt)}
                  </span>
                </div>
                <div className="mono mt-1 text-xs text-[var(--muted)]">
                  {s.model ?? "—"}
                  {s.latencyMs != null && ` · ${(s.latencyMs / 1000).toFixed(1)}s`}
                  {s.toolsUsed.length > 0 && ` · ${s.toolsUsed.join(", ")}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: string;
  note?: string;
  href: string;
}) {
  return (
    <Link href={href} className="panel panel-hover p-5">
      <div className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-[var(--text)]">{value}</div>
      {note && <div className="mono mt-0.5 text-xs text-[var(--muted)]">{note}</div>}
    </Link>
  );
}

function SectionHeading({ title, href }: { title: string; href?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-sm font-semibold">{title}</h2>
      {href && (
        <Link href={href} className="text-xs text-[var(--muted)] hover:text-[var(--brand-ink)]">
          View all →
        </Link>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="panel p-6 text-sm text-[var(--muted)]">{children}</div>;
}
