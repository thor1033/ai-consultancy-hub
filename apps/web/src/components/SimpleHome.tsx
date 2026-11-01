import Link from "next/link";
import { agentRoster, getPrincipal, waitingOnCount, type AgentRosterRow } from "@ai-hub/db";
import { listDocuments, type DocumentSummary } from "@ai-hub/rag";
import { sessionKnowledgeAccess } from "@/lib/sessionPrincipal";
import type { ViewContext } from "@/lib/viewServer";
import { AgentDirectory } from "./AgentDirectory";

// The home page in Simple view (docs/views.md). It answers the three things a
// person who uses the agents comes for — is anything waiting for me, who can
// help me, and what do the agents know — and nothing else: no figures, no
// costs, no servers. Everything else is one switch away, in Settings.

function greeting(now: Date): string {
  const zone = process.env.HUB_TIMEZONE?.trim() || "UTC";
  let hour = now.getUTCHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: zone }).format(now));
  } catch {
    /* an unknown zone: UTC */
  }
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export async function SimpleHome({ ctx }: { ctx: ViewContext }) {
  const principal = ctx.principal;
  const [roster, waiting, docs, row] = await Promise.all([
    agentRoster().catch(() => [] as AgentRosterRow[]),
    principal && ctx.can.run ? waitingOnCount(principal.id).catch(() => 0) : Promise.resolve(0),
    sessionKnowledgeAccess()
      .then((access) => listDocuments(access))
      .catch(() => [] as DocumentSummary[]),
    principal ? getPrincipal(principal.id).catch(() => null) : Promise.resolve(null),
  ]);
  const first = (row?.displayName || "").trim().split(/\s+/)[0];

  return (
    <main className="mx-auto max-w-[75rem] px-5 py-7 lg:px-8">
      <header>
        <div className="eyebrow">Home</div>
        <h1 className="mt-3 text-3xl md:text-4xl">
          {greeting(new Date())}
          {first ? `, ${first}` : ""}.
        </h1>
        <p className="mt-2 max-w-2xl text-[var(--text-soft)]">Ask an agent, run one of its tasks, or answer what is waiting for you.</p>
      </header>

      {ctx.can.run && (
        <Link
          href="/approvals"
          className={`panel panel-hover mt-6 flex items-center justify-between gap-4 p-5 ${waiting ? "border-l-2 border-l-[var(--brand)]" : ""}`}
        >
          <span className="flex items-center gap-3">
            <span aria-hidden className="inline-block h-3 w-3 shrink-0" style={{ background: waiting ? "var(--brand)" : "var(--ai)" }} />
            <span>
              <span className="block text-lg font-bold">
                {waiting ? `${waiting} ${waiting === 1 ? "change is" : "changes are"} waiting for you` : "Nothing is waiting for you"}
              </span>
              <span className="block text-sm text-[var(--muted)]">
                {waiting
                  ? "An agent wants to change something and needs your yes or no."
                  : "When an agent wants to change something, it asks you here first."}
              </span>
            </span>
          </span>
          <span aria-hidden className="text-[var(--muted)]">
            →
          </span>
        </Link>
      )}

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold">Who can help</h2>
          <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--brand)]">
            All agents →
          </Link>
        </div>
        <div className="mt-4">
          <AgentDirectory roster={roster} canRun={ctx.can.run} limit={6} />
        </div>
      </section>

      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="panel flex flex-col p-5">
          <h2 className="text-xl font-bold">What the agents know</h2>
          <p className="mt-1.5 text-sm text-[var(--text-soft)]">
            {docs.length
              ? `${docs.length} document${docs.length === 1 ? "" : "s"} the agents read before they answer.`
              : "No documents yet. Agents answer from what you tell them until someone adds some."}
          </p>
          <div className="mt-auto flex flex-wrap gap-2 pt-4">
            <Link href="/knowledge" className="btn min-h-10">
              {docs.length ? "Look through them" : "Open documents"}
            </Link>
            {ctx.can.write && (
              <Link href="/knowledge" className="btn min-h-10">
                Add a document
              </Link>
            )}
          </div>
        </div>
        <div className="panel flex flex-col p-5">
          <h2 className="text-xl font-bold">Want more control?</h2>
          <p className="mt-1.5 text-sm text-[var(--text-soft)]">
            This is the Simple view. Standard shows how the agents are set up and lets you change them; Expert shows every dial. Nothing is lost
            when you switch.
          </p>
          <div className="mt-auto pt-4">
            <Link href="/settings" className="btn min-h-10">
              Change the view
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
