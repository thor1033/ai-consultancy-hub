"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadRegistryAction,
  setSkillEnabledAction,
  setMcpEnabledAction,
} from "./actions";
import type { AdminSkill, AdminMcp, Registry } from "./types";

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

  // Resume a previously verified token so the console survives reloads.
  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      setToken(saved);
      load(saved);
    }
  }, [load]);

  async function toggleSkill(s: AdminSkill) {
    setPending(`skill:${s.slug}`);
    setError(null);
    const out = await setSkillEnabledAction(token, s.slug, !s.enabled);
    applyResult(out);
    setPending(null);
  }

  async function toggleMcp(m: AdminMcp) {
    setPending(`mcp:${m.name}`);
    setError(null);
    const out = await setMcpEnabledAction(token, m.name, !m.enabled);
    applyResult(out);
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
      <div className="max-w-md">
        <label className="block">
          <div className="mb-1 text-xs text-neutral-500">Admin token</div>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && token.trim() && load(token.trim())}
            placeholder="Bearer token with the admin role"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
          />
        </label>
        {error && (
          <div className="mt-3 rounded-lg border border-red-900/50 bg-red-950/30 p-3 text-sm text-red-300">
            {error}
          </div>
        )}
        <button
          onClick={() => token.trim() && load(token.trim())}
          disabled={loading || !token.trim()}
          className="mt-4 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-40"
        >
          {loading ? "Verifying…" : "Unlock control plane"}
        </button>
        <p className="mt-3 text-xs text-neutral-600">
          Tokens are configured in <code>HUB_API_TOKENS</code>; only the{" "}
          <code>admin</code> role may manage the control plane.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      <div className="flex justify-end">
        <button
          onClick={signOut}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Lock ↩
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* MCP servers */}
      <section>
        <SectionHeading
          title="MCP servers"
          subtitle="Tool servers agents connect to. A disabled server is dropped from every run."
        />
        <div className="space-y-3">
          {registry.mcpServers.map((m) => (
            <Row
              key={m.name}
              title={m.label || m.name}
              enabled={m.enabled}
              busy={pending === `mcp:${m.name}`}
              onToggle={() => toggleMcp(m)}
            >
              <p className="text-sm text-neutral-400">{m.description}</p>
              <div className="mt-1 text-xs text-neutral-500">
                <code>{m.name}</code>
                {" · "}
                {m.usedBySkills.length > 0
                  ? `used by ${m.usedBySkills.join(", ")}`
                  : "not used by any skill"}
              </div>
            </Row>
          ))}
        </div>
      </section>

      {/* Skills */}
      <section>
        <SectionHeading
          title="Skills"
          subtitle="Captured workflows. Disabling one blocks it from running and hides it from the catalog."
        />
        <div className="space-y-3">
          {registry.skills.map((s) => (
            <Row
              key={s.slug}
              title={s.name}
              enabled={s.enabled}
              busy={pending === `skill:${s.slug}`}
              onToggle={() => toggleSkill(s)}
            >
              <div className="text-xs text-neutral-500">
                <code>{s.slug}</code> · v{s.latestVersion ?? "—"}
                {s.mcpServers.length > 0 && ` · tools: ${s.mcpServers.join(", ")}`}
              </div>
              <AccessNote skill={s} />
            </Row>
          ))}
        </div>
      </section>
    </div>
  );
}

// The "why you can run this" explainer, straight from the policy model.
function AccessNote({ skill }: { skill: AdminSkill }) {
  const roles = skill.runnableRoles.join(", ");
  return (
    <p className="mt-1 text-xs text-neutral-500">
      <span className="text-neutral-400">Who can run: </span>
      {skill.grantedPrincipals.length > 0 ? (
        <>
          only <span className="text-neutral-300">{skill.grantedPrincipals.join(", ")}</span>{" "}
          (plus admins) — this skill has explicit grants.
        </>
      ) : (
        <>any principal with the <span className="text-neutral-300">{roles}</span> role.</>
      )}
    </p>
  );
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
        {title}
      </h2>
      <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>
    </div>
  );
}

function Row({
  title,
  enabled,
  busy,
  onToggle,
  children,
}: {
  title: string;
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-4 rounded-lg border p-4 transition ${
        enabled
          ? "border-neutral-800 bg-neutral-900/40"
          : "border-neutral-800/60 bg-neutral-950/40 opacity-70"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-neutral-100">{title}</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              enabled
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-neutral-800 text-neutral-500"
            }`}
          >
            {enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="mt-1">{children}</div>
      </div>
      <Toggle enabled={enabled} busy={busy} onToggle={onToggle} />
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
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
        enabled ? "bg-emerald-500" : "bg-neutral-700"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
