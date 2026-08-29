"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AgentSummary } from "@ai-hub/db";
import { saveAgentAction } from "./actions";

// The list of standing agents, plus the form that creates one. Creation is
// inline rather than on its own route: an agent is a handful of fields, and the
// point of the page is that making one is cheap.
export function AgentList({
  agents,
  servers,
}: {
  agents: AgentSummary[];
  servers: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(agents.length === 0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggle(server: string) {
    setPicked((p) => (p.includes(server) ? p.filter((s) => s !== server) : [...p, server]));
  }

  function save() {
    setError(null);
    start(async () => {
      const res = await saveAgentAction(null, {
        slug: name,
        name,
        description,
        instructions,
        mcpServers: picked.map((n) => ({ name: n })),
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.push(`/agents/${res.slug}`);
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <button className="btn" onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "New agent"}
        </button>
      </div>

      {open && (
        <div className="panel space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Name</span>
              <input
                className="field mt-1 w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Delivery Lead"
              />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Description</span>
              <input
                className="field mt-1 w-full"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Watches delivery and reports status"
              />
            </label>
          </div>

          <label className="block text-sm">
            <span className="text-[var(--muted)]">Instructions</span>
            <textarea
              className="field mt-1 h-28 w-full resize-y"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="You are a delivery lead for a consultancy. Check memory first, then use the pm-tool server for live project state…"
            />
          </label>

          <div className="text-sm">
            <span className="text-[var(--muted)]">Tool servers</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {servers.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggle(s)}
                  className={`chip ${picked.includes(s) ? "text-[var(--brand-ink)]" : "text-[var(--muted)]"}`}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="mono mt-2 text-xs text-[var(--muted)]">
              memory is attached automatically — every agent gets its own.
            </p>
          </div>

          {error && <p className="text-sm text-[var(--warning)]">{error}</p>}

          <button className="btn-brand" onClick={save} disabled={pending || !name.trim()}>
            {pending ? "Creating…" : "Create agent"}
          </button>
        </div>
      )}

      {agents.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-[var(--muted)]">
          No agents yet. Create one to give it instructions, tools and a memory.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <Link key={a.id} href={`/agents/${a.slug}`} className="panel panel-hover group p-5">
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
                  {a.memoryCount} {a.memoryCount === 1 ? "memory" : "memories"}
                </span>
                <span className="text-[var(--muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--brand-ink)]">
                  Open →
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
