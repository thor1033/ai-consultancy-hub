"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useView } from "@/components/ViewProvider";
import { addConnectionAction, type ConnectionResult } from "./actions";

// Adding a connection from the page (docs/connections.md): a name, the
// address the other system gave you, and its token if it needs one. The hub
// dials it before saving, so a typo shows here and not in an agent's run;
// when it cannot answer right now, saving anyway is one more click.
export function AddConnection({ sealing }: { sealing: { ok: true } | { ok: false; reason: string } }) {
  const router = useRouter();
  const expert = useView().view === "expert";
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [pending, start] = useTransition();

  const submit = (force: boolean) =>
    start(async () => {
      const res = await addConnectionAction({ label, name: expert ? name : undefined, url, token, description, force });
      setResult(res);
      if ("ok" in res) {
        setLabel("");
        setName("");
        setUrl("");
        setToken("");
        setDescription("");
        router.refresh();
      }
    });

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-2">
        <button type="button" className="btn-brand min-h-11" onClick={() => setOpen(true)}>
          Add a connection
        </button>
        {result && "ok" in result && (
          <p role="status" className="text-sm text-[var(--text-soft)]">
            Added{result.tools !== null ? `, with ${result.tools} tool${result.tools === 1 ? "" : "s"}` : ""}. Give it to an agent on the agent&apos;s
            Settings, under &ldquo;What it may use&rdquo;.
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="panel p-5 md:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xl">Add a connection</h2>
        <button type="button" className="text-xs font-medium uppercase tracking-[0.18em] hover:text-[var(--brand)]" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">
        Another system that speaks MCP — a CRM, a project board, a ticket queue — gives you an address and usually a token. Paste them here; the
        token is stored encrypted and never shown again.
      </p>
      {!sealing.ok && <p className="panel notice-warning mt-3 p-3 text-sm">{sealing.reason}</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">Name</span>
          <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="CRM" required maxLength={60} />
        </label>
        {expert && (
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--muted)]">Short name agents use (optional)</span>
            <input className="field mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="made from the name" />
          </label>
        )}
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs text-[var(--muted)]">Address</span>
          <input className="field" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://crm.example.com/mcp" required inputMode="url" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs text-[var(--muted)]">Token (optional)</span>
          <input
            className="field"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Leave empty if it needs none"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs text-[var(--muted)]">What it is for (optional)</span>
          <input
            className="field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Customer accounts and deals, read and write"
            maxLength={500}
          />
        </label>
      </div>
      {result && "error" in result && (
        <div role="alert" className="mt-3 text-sm text-[var(--danger)]">
          <p>{result.error}</p>
          {result.canForce && (
            <button type="button" className="btn mt-2 min-h-10" disabled={pending} onClick={() => submit(true)}>
              Save it anyway
            </button>
          )}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" className="btn-brand min-h-11" disabled={pending || !sealing.ok || !label.trim() || !url.trim()}>
          {pending ? "Checking it answers…" : "Check and add"}
        </button>
        <button type="button" className="btn min-h-11" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
