"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Proposal } from "@ai-hub/db";
import { rel } from "@/lib/format";
import { Markdown } from "@/components/Markdown";
import { approveProposalAction, rejectProposalAction } from "./actions";

export function ApprovalsView({ pending, decided, viewerId }: { pending: Proposal[]; decided: Proposal[]; viewerId: string }) {
  const now = Date.now();
  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="eyebrow mb-3">Waiting · {pending.length}</div>
        {pending.length === 0 ? (
          <div className="panel p-6">
            <p className="text-sm text-[var(--text-soft)]">
              Nothing is waiting. When an agent reaches for a tool that writes, the call lands here instead of happening.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {pending.map((p) => (
              <ProposalCard key={p.id} p={p} now={now} viewerId={viewerId} live />
            ))}
          </div>
        )}
      </section>

      {decided.length > 0 && (
        <section>
          <div className="eyebrow mb-3">Decided</div>
          <div className="flex flex-col gap-3">
            {decided.map((p) => (
              <ProposalCard key={p.id} p={p} now={now} viewerId={viewerId} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const STATUS: Record<Proposal["status"], { label: string; color: string }> = {
  pending: { label: "Waiting", color: "var(--ai)" },
  approved: { label: "Running", color: "var(--ai)" },
  executed: { label: "Done", color: "var(--text)" },
  failed: { label: "Failed", color: "var(--danger)" },
  rejected: { label: "Rejected", color: "var(--muted)" },
};

function ProposalCard({ p, now, viewerId, live = false }: { p: Proposal; now: number; viewerId: string; live?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[p.status];
  const actedAs = p.principalId === viewerId ? "you" : p.principalName || p.principalId || "nobody in particular";

  function decide(fn: () => Promise<{ proposal: Proposal } | { error: string }>) {
    setError(null);
    start(async () => {
      const res = await fn();
      if ("error" in res) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <article className={`panel p-5 ${live ? "" : "opacity-80"}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base">
          <span className="mono">{p.tool}</span>
          <span className="text-[var(--muted)]"> on {p.server}</span>
        </h2>
        <span className="flex items-center gap-2 text-xs" style={{ color: status.color }}>
          <span aria-hidden className="inline-block h-2 w-2" style={{ background: status.color }} />
          {status.label}
        </span>
      </header>
      <p className="mt-1 text-xs text-[var(--muted)]">
        {p.agentSlug ? (
          <Link href={`/agents/${p.agentSlug}`} className="underline underline-offset-2">
            {p.agentName}
          </Link>
        ) : (
          "A workbench session"
        )}
        {" · acting as "}
        {actedAs}
        {" · "}
        {rel(p.createdAt, now).toLowerCase()}
        {p.decidedBy && (
          <>
            {" · "}
            {p.status === "rejected" ? "rejected" : "approved"} by {p.decidedBy === viewerId ? "you" : p.decidedBy}
          </>
        )}
      </p>
      {p.reason ? (
        <p className="mt-3 text-base">{p.reason}</p>
      ) : (
        <p className="mt-3 text-sm text-[var(--muted)]">The agent gave no reason. Judge it from the arguments below, or reject it and ask.</p>
      )}
      {p.description && <p className="mt-2 text-xs text-[var(--text-soft)]">{p.description}</p>}

      {p.tool === "knowledge_file_document" && typeof p.args?.content === "string" ? (
        // The steward's filing: the reviewer reads what will be retrievable,
        // as a document, not as a JSON blob with a content field.
        <FiledDocument args={p.args} />
      ) : (
      <div className="md mt-3">
        <div className="md-table">
          <table>
            <thead>
              <tr>
                <th>Argument</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(p.args ?? {}).length === 0 ? (
                <tr>
                  <td colSpan={2} className="text-[var(--muted)]">
                    No arguments.
                  </td>
                </tr>
              ) : (
                Object.entries(p.args).map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <span className="mono">{k}</span>
                    </td>
                    <td>
                      <pre className="!m-0 !border-0 !bg-transparent !p-0 whitespace-pre-wrap">{typeof v === "string" ? v : JSON.stringify(v, null, 2)}</pre>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {p.runPrompt && (
        <details className="mt-2 text-xs text-[var(--muted)]">
          <summary className="cursor-pointer">What the agent was asked</summary>
          <p className="mt-1 whitespace-pre-wrap">{p.runPrompt.length > 1200 ? `${p.runPrompt.slice(0, 1200)}…` : p.runPrompt}</p>
        </details>
      )}

      {p.status === "executed" && p.result && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-[var(--muted)]">What the tool returned</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap bg-[var(--panel-inset)] p-3 text-xs">{p.result.length > 4000 ? `${p.result.slice(0, 4000)}…` : p.result}</pre>
        </details>
      )}
      {p.status === "failed" && <p className="mt-2 text-sm text-[var(--danger)]">Approved, but the call failed: {p.error}</p>}
      {p.status === "rejected" && p.note && <p className="mt-2 text-sm text-[var(--text-soft)]">Note: {p.note}</p>}

      {live && p.status === "pending" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!rejecting ? (
            <>
              <button type="button" className="btn-brand min-h-10" disabled={pending} onClick={() => decide(() => approveProposalAction(p.id))}>
                {pending ? "Working…" : "Approve and run it"}
              </button>
              <button type="button" className="btn min-h-10" disabled={pending} onClick={() => setRejecting(true)}>
                Reject
              </button>
            </>
          ) : (
            <>
              <input className="field min-w-[16rem] flex-1" placeholder="Why not (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="btn-brand min-h-10" disabled={pending} onClick={() => decide(() => rejectProposalAction(p.id, note))}>
                Reject it
              </button>
              <button type="button" className="btn min-h-10" onClick={() => setRejecting(false)}>
                Back
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </article>
  );
}

function FiledDocument({ args }: { args: Record<string, unknown> }) {
  const source = args.source && typeof args.source === "object" ? (args.source as { kind?: string; id?: string; detail?: string }) : null;
  return (
    <div className="mt-3 border border-[var(--border-strong)]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--border)] px-4 py-2.5 text-xs text-[var(--muted)]">
        <span>
          Files into <span className="mono text-[var(--text)]">{String(args.collection ?? "")}</span>
        </span>
        {source && (
          <span>
            From {source.kind === "chat" ? "a chat" : source.kind === "note" ? "a meeting note" : `${source.id}'s memory`}
            {source.kind !== "memory" && source.id && <span className="mono"> {String(source.id).slice(0, 8)}</span>}
            {source.detail ? `, ${source.detail}` : ""}
          </span>
        )}
      </div>
      <div className="px-4 py-3">
        <h3 className="text-lg font-bold">{String(args.title ?? "")}</h3>
        <Markdown className="mt-2">{String(args.content)}</Markdown>
      </div>
    </div>
  );
}
