"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TemporaryAccessRow } from "@ai-hub/db";
import { endTemporaryAccessAction, grantTemporaryAccessAction } from "./temporaryActions";

// Temporary access — break-glass (docs/client-deployment.md). Who has it,
// until when, why, and what they did with it; and the form to grant it.

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export function TemporaryAccess({ rows, canGrant }: { rows: TemporaryAccessRow[]; canGrant: boolean }) {
  const live = rows.filter((r) => r.live);
  const ended = rows.filter((r) => !r.live);
  return (
    <div className="space-y-4">
      {live.length > 0 && (
        <div role="status" className="panel notice-warning p-4 text-sm">
          <strong>
            {live.length === 1 ? `${live[0].displayName || live[0].email} has` : `${live.length} people have`} temporary access right now.
          </strong>{" "}
          It ends by itself; you can end it sooner below.
        </div>
      )}
      {rows.length > 0 && (
        <ul className="panel divide-y divide-[var(--border)]">
          {[...live, ...ended].map((r) => (
            <Grant key={r.id} row={r} />
          ))}
        </ul>
      )}
      {canGrant ? (
        <GrantForm />
      ) : (
        <p className="text-sm text-[var(--muted)]">Only an admin with standing access can grant temporary access.</p>
      )}
    </div>
  );
}

function Grant({ row }: { row: TemporaryAccessRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0">
        <div className="font-medium">
          {row.displayName || row.email} <span className="font-normal text-[var(--muted)]">· {row.roles.join(", ")}</span>
        </div>
        <div className="mt-0.5 text-[var(--text-soft)]">{row.reason}</div>
        <div className="mt-1 text-xs text-[var(--muted)]">
          {row.live ? `Until ${when(row.expiresAt)}` : `Ended ${when(row.expiresAt)}`} · granted by {row.grantedBy ?? "—"} on {when(row.grantedAt)} · since then:{" "}
          {row.runs} conversations, {row.reads} reads of confidential material, {row.events} audit entries
        </div>
        {error && <div className="mt-1 text-xs text-[var(--danger)]">{error}</div>}
      </div>
      {row.live && (
        <button
          type="button"
          className="btn min-h-10 border-[var(--danger)] text-[var(--danger)]"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const out = await endTemporaryAccessAction(row.id);
              if ("error" in out) setError(out.error);
              else router.refresh();
            })
          }
        >
          {pending ? "Ending…" : "End now"}
        </button>
      )}
    </li>
  );
}

function GrantForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("admin");
  const [hours, setHours] = useState(4);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="panel max-w-2xl space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const out = await grantTemporaryAccessAction({ email, name, role, hours, reason });
          if ("error" in out) setMessage({ ok: false, text: out.error });
          else {
            setMessage({ ok: true, text: `Granted until ${when(out.until)}.${out.note ? ` ${out.note}` : ""}` });
            setEmail("");
            setName("");
            setReason("");
            router.refresh();
          }
        });
      }}
    >
      <h3 className="text-sm font-semibold">Grant temporary access</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">Email</span>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">Name (optional)</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">What they may do</span>
          <select className="field" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="admin">Admin — fix agents, connections and runs</option>
            <option value="analyst">Analyst — use agents and documents</option>
            <option value="viewer">Viewer — read documents</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">For how many hours (at most 72)</span>
          <input className="field" type="number" min={1} max={72} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Why — kept with the grant</span>
        <textarea className="field min-h-20" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <p className="text-xs text-[var(--muted)]">
        It ends by itself, everywhere at once: the web app, Claude Code, and anything they set up while they had it. They can work in the hub,
        but cannot change who has access, relabel what may leave, or download other people&apos;s data.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn-brand" disabled={pending}>
          {pending ? "Granting…" : "Grant"}
        </button>
        {message && <span className={`text-sm ${message.ok ? "text-[var(--text-soft)]" : "text-[var(--danger)]"}`}>{message.text}</span>}
      </div>
    </form>
  );
}
