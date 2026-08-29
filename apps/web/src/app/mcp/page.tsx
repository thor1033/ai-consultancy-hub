import Link from "next/link";
import { listSkillsAdmin } from "@ai-hub/db";
import { countMcpTools, listRegisteredServers } from "@/lib/mcpCatalog";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

// MCP explorer overview: every registered tool server, its status, and which
// Skills use it. Click through for the live tool list and details.
export default async function McpOverviewPage() {
  let servers: Awaited<ReturnType<typeof listRegisteredServers>> = [];
  const usedBy = new Map<string, string[]>();
  const toolCounts = new Map<string, number | null>();
  let error: string | null = null;
  try {
    const [srv, skills] = await Promise.all([listRegisteredServers(), listSkillsAdmin()]);
    servers = srv;
    for (const s of skills) {
      for (const e of s.mcpServers) {
        if (typeof e.name === "string") {
          usedBy.set(e.name, [...(usedBy.get(e.name) ?? []), s.name]);
        }
      }
    }
    // Introspect every server's tool count in parallel; failures show "—".
    const counts = await Promise.all(servers.map((s) => countMcpTools(s.name)));
    servers.forEach((s, i) => toolCounts.set(s.name, counts[i]));
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load MCP servers.";
  }

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="MCP"
        title="Tool servers"
        subtitle="The Model Context Protocol servers your agents can connect to. Open one to inspect its tools and details."
      />

      {error ? (
        <div className="panel border-l-2 border-l-[var(--warning)] p-4 text-sm text-[var(--warning)]">
          {error}
        </div>
      ) : servers.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-[var(--muted)]">
          No MCP servers registered.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s) => {
            const skills = usedBy.get(s.name) ?? [];
            const count = toolCounts.get(s.name);
            return (
              <Link key={s.name} href={`/mcp/${s.name}`} className="panel panel-hover group p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{s.label || s.name}</h3>
                  <span
                    className="dot"
                    style={{
                      color: s.enabled ? "var(--positive)" : "var(--muted)",
                      background: s.enabled ? "var(--positive)" : "var(--muted)",
                    }}
                  />
                </div>
                <div className="mono mt-0.5 text-xs text-[var(--muted)]">{s.name}</div>
                <p className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">
                  {s.description || "No description."}
                </p>
                <div className="mt-4 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="mono rounded border border-[var(--border)] bg-[var(--panel-inset)] px-1.5 py-0.5 text-[var(--brand-ink)]">
                      {count == null ? "—" : count} tool{count === 1 ? "" : "s"}
                    </span>
                    <span className="text-[var(--muted)]">
                      {skills.length > 0 ? `${skills.length} skill${skills.length === 1 ? "" : "s"}` : "unused"}
                    </span>
                  </div>
                  <span className="text-[var(--muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--brand-ink)]">
                    Inspect →
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
