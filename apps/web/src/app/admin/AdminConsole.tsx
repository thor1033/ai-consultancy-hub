"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadRegistryAction,
  setMcpEnabledAction,
  deleteMcpServerAction,
} from "./actions";
import type { AdminMcp, Registry } from "./types";

const TOKEN_KEY = "hub-admin-token";

export function AdminConsole() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async (t: string) => {
    setLoading(true);
    setError(null);
    const out = await loadRegistryAction(t);
    if ("error" in out) {
      setError(out.error);
      setAuthed(false);
      localStorage.removeItem(TOKEN_KEY);
    } else {
      setRegistry(out);
      setAuthed(true);
      localStorage.setItem(TOKEN_KEY, t);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      setToken(saved);
      load(saved);
    }
  }, [load]);

  async function toggleMcp(m: AdminMcp) {
    setPending(`mcp:${m.name}`);
    setError(null);
    applyResult(await setMcpEnabledAction(token, m.name, !m.enabled));
    setPending(null);
  }

  async function removeMcp(m: AdminMcp) {
    const warning = m.declared
      ? `"${m.name}" is declared in HUB_REMOTE_MCP_SERVERS, so it will be registered again on the next read. To stop using it, disable it or remove it from that variable.\n\nDelete the row anyway?`
      : `Delete "${m.name}" from the registry? Agents will no longer be offered its tools.`;
    if (!confirm(warning)) return;
    setPending(`mcp:${m.name}`);
    setError(null);
    applyResult(await deleteMcpServerAction(token, m.name));
    setPending(null);
  }

  function applyResult(out: Registry | { error: string }) {
    if ("error" in out) setError(out.error);
    else setRegistry(out);
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    setAuthed(false);
    setRegistry(null);
    setToken("");
  }

  if (!authed || !registry) {
    return (
      <div className="panel max-w-md p-5">
        <label className="block">
          <div className="mb-1 text-xs text-[var(--muted)]">Admin token</div>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && token.trim() && load(token.trim())}
            placeholder="Bearer token with the admin role"
            className="field"
          />
        </label>
        {error && (
          <div className="mt-3 rounded-lg border border-[var(--border)] border-l-2 border-l-[var(--danger)] p-3 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
        <button
          onClick={() => token.trim() && load(token.trim())}
          disabled={loading || !token.trim()}
          className="btn-brand mt-4"
        >
          {loading ? "Verifying…" : "Unlock control plane"}
        </button>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Tokens are configured in <code>HUB_API_TOKENS</code>; only the{" "}
          <code>admin</code> role may manage the control plane.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-end">
        <button
          onClick={signOut}
          className="chip"
        >
          Lock ↩
        </button>
      </div>

      {error && (
        <div className="panel border-l-2 border-l-[var(--danger)] p-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      <section>
        <SectionHeading
          title="MCP servers"
          subtitle="Tool servers agents connect to. Disabling drops a server from every run; deleting removes it from the registry."
        />
        <div className="space-y-2">
          {registry.mcpServers.map((m) => (
            <Row
              key={m.name}
              title={m.label || m.name}
              enabled={m.enabled}
              busy={pending === `mcp:${m.name}`}
              onToggle={() => toggleMcp(m)}
              onDelete={() => removeMcp(m)}
            >
              <p className="text-sm text-[var(--text-soft)]">{m.description}</p>
              <div className="mono mt-1 text-xs text-[var(--muted)]">
                {m.name}
                {" · "}
                {m.declared ? "declared in env" : "registry only"}
              </div>
            </Row>
          ))}
        </div>
      </section>

    </div>
  );
}


function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-0.5 text-sm text-[var(--muted)]">{subtitle}</p>
    </div>
  );
}

function Row({
  title,
  enabled,
  busy,
  onToggle,
  onDelete,
  children,
}: {
  title: string;
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`panel flex items-start justify-between gap-4 p-4 ${enabled ? "" : "opacity-65"}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-[var(--text)]">{title}</h3>
          <span
            className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              enabled
                ? "bg-[var(--brand-soft)] text-[var(--positive)]"
                : "border border-[var(--border)] text-[var(--muted)]"
            }`}
          >
            {enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="mt-1">{children}</div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Toggle enabled={enabled} busy={busy} onToggle={onToggle} />
        <button
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete ${title}`}
          title="Delete from the registry"
          className="chip text-[var(--danger)] disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function Toggle({
  enabled,
  busy,
  onToggle,
}: {
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      disabled={busy}
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition disabled:opacity-50 ${
        enabled ? "brand-gradient border-transparent" : "border-[var(--border)] bg-[var(--panel-inset)]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full shadow transition-transform ${
          enabled ? "translate-x-5 bg-white" : "translate-x-0.5 bg-[var(--muted)]"
        }`}
      />
    </button>
  );
}
