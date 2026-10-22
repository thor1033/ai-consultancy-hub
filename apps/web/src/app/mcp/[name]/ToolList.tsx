"use client";

import { useState } from "react";
import type { McpToolInfo } from "@/lib/mcpCatalog";

// A server's tools, as the model sees them: name, what it is for, and its
// arguments. Usage is worked out on the server and handed down as text, so the
// "2h ago" here matches the rest of the page rather than the browser's clock.

export interface ToolRow extends McpToolInfo {
  calls: number;
  usage: string;
}

export function ToolList({ tools }: { tools: ToolRow[] }) {
  const [q, setQ] = useState("");
  const [order, setOrder] = useState<"used" | "name">("used");
  const needle = q.trim().toLowerCase();
  const shown = tools
    .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle))
    .sort((a, b) => (order === "used" ? b.calls - a.calls || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)));

  return (
    <div>
      {tools.length > 5 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            className="field min-w-0 flex-1"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Filter ${tools.length} tools…`}
            aria-label="Filter tools"
          />
          <div className="flex" role="group" aria-label="Sort tools">
            {(
              [
                ["used", "Most used"],
                ["name", "A–Z"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={order === id}
                onClick={() => setOrder(id)}
                className={`min-h-10 border px-3 text-sm ${
                  order === id
                    ? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]"
                    : "border-[var(--border-strong)] text-[var(--muted)] hover:text-[var(--text)]"
                } -ml-px first:ml-0`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="inset p-4 text-sm text-[var(--muted)]">No tool matches “{q}”.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((t) => (
            <li key={t.name} className="panel p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="mono break-all text-sm font-medium">{t.name}</span>
                <span className={`text-xs ${t.calls ? "text-[var(--text-soft)]" : "text-[var(--faint)]"}`}>
                  {t.calls > 0 && <span aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 bg-[var(--ai)]" />}
                  {t.usage}
                </span>
              </div>
              {t.description && (
                <p className="mt-1.5 line-clamp-3 text-sm text-[var(--text-soft)]">{t.description}</p>
              )}
              {t.params.length > 0 && (
                <details className="group mt-2.5">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 text-xs">
                    {t.params.map((p) => (
                      <span key={p.name} className="mono border border-[var(--border-strong)] px-1.5 py-0.5">
                        {p.name}
                        {!p.required && <span className="text-[var(--muted)]">?</span>}
                        <span className="text-[var(--muted)]">: {p.type}</span>
                      </span>
                    ))}
                    <span className="ml-1 text-[var(--muted)] group-open:hidden">Details</span>
                    <span className="ml-1 hidden text-[var(--muted)] group-open:inline">Hide</span>
                  </summary>
                  <dl className="mt-2 flex flex-col gap-1">
                    {t.params.map((p) => (
                      <div key={p.name} className="inset px-3 py-2 text-xs">
                        <dt className="flex flex-wrap items-baseline gap-2">
                          <span className="mono font-medium">{p.name}</span>
                          <span className="mono text-[var(--muted)]">{p.type}</span>
                          <span className={p.required ? "text-[var(--brand)]" : "text-[var(--muted)]"}>
                            {p.required ? "required" : "optional"}
                          </span>
                        </dt>
                        {p.description && <dd className="mt-0.5 text-[var(--text-soft)]">{p.description}</dd>}
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
