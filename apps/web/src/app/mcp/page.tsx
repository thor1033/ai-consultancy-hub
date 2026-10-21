import Link from "next/link";
import { Suspense } from "react";
import { countMcpTools, listRegisteredServers } from "@/lib/mcpCatalog";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

// MCP explorer overview: every registered tool server, its status, and which
// Skills use it. Click through for the live tool list and details.
//
// The cards come from the registry (one database read) and paint at once. The
// tool count on each card needs a live connection to that server, so it
// streams in behind a Suspense boundary: a server that is slow or down costs
// its own count, not the page. This page used to await every connection before
// sending anything, which is why the sidebar link seemed to need two clicks.
export default async function McpOverviewPage() {
  let servers: Awaited<ReturnType<typeof listRegisteredServers>> = [];
  let error: string | null = null;
  try {
    servers = await listRegisteredServers();
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
        <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">
          {error}
        </div>
      ) : servers.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-[var(--muted)]">
          No MCP servers registered.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s) => (
            <Link key={s.name} href={`/mcp/${s.name}`} className="panel panel-hover group p-5">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">{s.label || s.name}</h3>
                <span
                  className="dot"
                  style={{ background: s.enabled ? "var(--ai)" : "var(--faint)" }}
                />
              </div>
              <div className="mono mt-0.5 text-xs text-[var(--muted)]">{s.name}</div>
              <p className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">
                {s.description || "No description."}
              </p>
              <div className="mt-4 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="mono border border-[var(--border)] bg-[var(--panel-inset)] px-1.5 py-0.5 text-[var(--text-soft)]">
                    <Suspense fallback={<>… tools</>}>
                      <ToolCount name={s.name} />
                    </Suspense>
                  </span>
                  <span className="text-[var(--muted)]">
                    {s.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <span className="text-[var(--muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--brand-ink)]">
                  Inspect →
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

/** Connects, counts, closes — within the introspection deadline. "—" if it could not be reached. */
async function ToolCount({ name }: { name: string }) {
  const count = await countMcpTools(name);
  return (
    <>
      {count == null ? "—" : count} tool{count === 1 ? "" : "s"}
    </>
  );
}
