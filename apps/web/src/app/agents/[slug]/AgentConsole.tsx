"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Agent, AgentMemory, Placement } from "@ai-hub/db";
import {
  sendAgentMessageAction,
  saveAgentAction,
  deleteAgentAction,
  forgetMemoryAction,
  setMemoryActiveAction,
  type AgentChatMessage,
} from "../actions";

const PLACEMENT_OPTIONS: { id: Placement; label: string; help: string }[] = [
  {
    id: "hub",
    label: "Hub",
    help: "Runs on the hub: this console, hub_agent_* tools in connected clients, and schedules.",
  },
  {
    id: "local",
    label: "Local",
    help: "Synced into Claude Code as a sub-agent with its skills. The hub no longer runs it, and its schedules pause.",
  },
  {
    id: "both",
    label: "Both",
    help: "Runs on the hub as today and is also synced into Claude Code.",
  },
];

const MODELS = [
  { id: "", label: "Default" },
  { id: "claude-opus-4-8", label: "Opus" },
  { id: "claude-sonnet-4-6", label: "Sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku" },
];

interface Meta {
  model: string;
  costUsd: number;
  latencyMs: number;
  toolsUsed: string[];
  servers: string[];
  sources: number;
}

const serverNames = (agent: Agent): string[] =>
  (agent.mcpServers ?? [])
    .map((e) => (typeof e === "string" ? e : String((e as { name?: unknown }).name ?? "")))
    .filter(Boolean);

export function AgentConsole({
  agent,
  memories,
  servers,
  collections,
  // Handed down rather than imported: @ai-hub/agent pulls in the Anthropic SDK
  // and langfuse, and this is a client component.
  defaultMaxIterations,
  maxIterationsCeiling,
  canSetPlacement,
  localFiles,
  localActivity,
}: {
  agent: Agent;
  memories: AgentMemory[];
  servers: string[];
  collections: string[];
  defaultMaxIterations: number;
  maxIterationsCeiling: number;
  /** Only an admin may move an agent between the hub and Claude Code. */
  canSetPlacement: boolean;
  /** What a sync would write for this agent, if it were placed local. */
  localFiles: { path: string; content: string }[];
  localActivity: { calls: number; failed: number; people: number; lastAt: string | null } | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"chat" | "memory" | "settings">("chat");

  // ── chat ──────────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [lastMeta, setLastMeta] = useState<Meta | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [sending, startSend] = useTransition();

  function send() {
    const text = draft.trim();
    if (!text) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setChatError(null);
    startSend(async () => {
      const res = await sendAgentMessageAction(agent.slug, next);
      if ("error" in res) {
        setChatError(res.error);
        return;
      }
      setMessages([...next, { role: "assistant", content: res.content }]);
      setLastMeta(res.meta);
      // The turn may have written a memory; pull the server state back in.
      router.refresh();
    });
  }

  // ── settings ──────────────────────────────────────────────────────────────
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [model, setModel] = useState(agent.model ?? "");
  const [collection, setCollection] = useState(agent.knowledgeCollection ?? "");
  // Kept as a string so the box can be emptied back to "use the default"
  // rather than forcing a number the moment it is touched.
  const [maxIterations, setMaxIterations] = useState(
    agent.maxIterations === null ? "" : String(agent.maxIterations),
  );
  const [picked, setPicked] = useState<string[]>(serverNames(agent));
  const [enabled, setEnabled] = useState(agent.enabled);
  const [placement, setPlacement] = useState<Placement>(agent.placement);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  function save() {
    setSaveMsg(null);
    startSave(async () => {
      const res = await saveAgentAction(agent.id, {
        slug: agent.slug,
        name,
        description,
        instructions,
        model: model || null,
        knowledgeCollection: collection || null,
        maxIterations: maxIterations.trim() === "" ? null : Number(maxIterations),
        mcpServers: picked.map((n) => ({ name: n })),
        enabled,
        placement,
      });
      setSaveMsg("error" in res ? res.error : "Saved.");
      if (!("error" in res)) router.refresh();
    });
  }

  function remove() {
    if (!confirm(`Delete ${agent.name}? Everything it remembers goes with it.`)) return;
    startSave(async () => {
      const res = await deleteAgentAction(agent.id);
      if (!res.ok) {
        setSaveMsg(res.error ?? "Could not delete the agent.");
        return;
      }
      router.push("/agents");
    });
  }

  const tabs = [
    ["chat", "Conversation"],
    ["memory", `Memory (${memories.length})`],
    ["settings", "Settings"],
  ] as const;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`chip ${tab === id ? "text-[var(--brand-ink)]" : "text-[var(--muted)]"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "chat" && agent.placement === "local" && (
        <div className="panel p-5 text-sm text-[var(--muted)]">
          {agent.name} runs locally, as the <span className="mono">hub-{agent.slug}</span> sub-agent in
          Claude Code, so the hub does not run it here. Set it to <strong>Hub</strong> or{" "}
          <strong>Both</strong> under Settings to talk to it in this console.
        </div>
      )}

      {tab === "chat" && agent.placement !== "local" && (
        <div className="panel p-5">
          <div className="space-y-3">
            {messages.length === 0 && (
              <p className="text-sm text-[var(--muted)]">
                Nothing said yet. This agent recalls what it learned in earlier conversations —
                ask it what it remembers.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`rounded-lg p-3 text-sm ${
                  m.role === "user"
                    ? "bg-[var(--panel-inset)]"
                    : "border border-[var(--border)]"
                }`}
              >
                <div className="mono mb-1 text-xs text-[var(--muted)]">
                  {m.role === "user" ? "You" : agent.name}
                </div>
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            ))}
            {sending && <p className="text-sm text-[var(--muted)]">Thinking…</p>}
            {chatError && <p className="text-sm text-[var(--warning)]">{chatError}</p>}
          </div>

          <div className="mt-4 flex gap-2">
            <textarea
              className="field h-20 flex-1 resize-y"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
              placeholder="Ask this agent something…  (⌘/Ctrl+Enter to send)"
            />
            <button className="btn-brand self-end" onClick={send} disabled={sending || !draft.trim()}>
              Send
            </button>
          </div>

          {lastMeta && (
            <p className="mono mt-3 text-xs text-[var(--muted)]">
              {lastMeta.model} · {lastMeta.latencyMs}ms · ${lastMeta.costUsd.toFixed(4)}
              {lastMeta.toolsUsed.length > 0 && ` · tools: ${lastMeta.toolsUsed.join(", ")}`}
              {lastMeta.sources > 0 && ` · ${lastMeta.sources} knowledge chunk(s)`}
            </p>
          )}
        </div>
      )}

      {tab === "memory" && (
        <div className="panel p-5">
          <p className="mb-4 text-sm text-[var(--muted)]">
            What this agent has chosen to remember. It writes these itself through the{" "}
            <span className="mono">memory</span> server. Active memories are the work in flight
            and are loaded at the start of every conversation; inactive ones are kept and
            searchable but not loaded. Delete any that are wrong.
          </p>
          {memories.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Nothing remembered yet.</p>
          ) : (
            <div className="space-y-6">
              {(
                [
                  ["Active work", memories.filter((m) => m.active)],
                  ["Inactive", memories.filter((m) => !m.active)],
                ] as const
              ).map(([heading, group]) => (
                <section key={heading}>
                  <h3 className="mb-2 text-sm font-semibold">
                    {heading} ({group.length})
                  </h3>
                  {group.length === 0 ? (
                    <p className="text-sm text-[var(--muted)]">None.</p>
                  ) : (
                    <ul className="space-y-3">
                      {group.map((m) => (
                        <li
                          key={m.id}
                          className={`rounded-lg border border-[var(--border)] p-3 ${m.active ? "" : "opacity-75"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="mono text-xs text-[var(--brand-ink)]">{m.key}</div>
                              <p className="mt-1 text-sm">{m.content}</p>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              <button
                                className="btn"
                                onClick={() =>
                                  startSave(async () => {
                                    const res = await setMemoryActiveAction(agent.id, m.key, !m.active);
                                    if (res.error) alert(res.error);
                                    router.refresh();
                                  })
                                }
                              >
                                {m.active ? "Set inactive" : "Set active"}
                              </button>
                              <button
                                className="btn"
                                onClick={() =>
                                  startSave(async () => {
                                    const res = await forgetMemoryAction(agent.id, m.key);
                                    if (res.error) alert(res.error);
                                    router.refresh();
                                  })
                                }
                              >
                                Forget
                              </button>
                            </div>
                          </div>
                          <div className="mono mt-2 text-xs text-[var(--muted)]">
                            updated {new Date(m.updatedAt).toLocaleString()}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "settings" && (
        <div className="panel space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Name</span>
              <input className="field mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Description</span>
              <input
                className="field mt-1 w-full"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>

          <label className="block text-sm">
            <span className="text-[var(--muted)]">Instructions</span>
            <textarea
              className="field mt-1 h-40 w-full resize-y"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Model</span>
              <select className="field mt-1 w-full" value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Knowledge collection</span>
              <select
                className="field mt-1 w-full"
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
              >
                <option value="">None</option>
                {collections.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-sm">
            <span className="text-[var(--muted)]">Tool-use rounds per run</span>
            <input
              className="field mono mt-1 w-full sm:w-40"
              type="number"
              min={1}
              max={maxIterationsCeiling}
              value={maxIterations}
              placeholder={String(defaultMaxIterations)}
              onChange={(e) => setMaxIterations(e.target.value)}
            />
            <p className="mono mt-2 text-xs text-[var(--muted)]">
              Blank uses the default ({defaultMaxIterations}); the ceiling is{" "}
              {maxIterationsCeiling}. Raise it for an agent that works through a
              queue — a run that hits the limit stops mid-task and says so.
            </p>
          </label>

          <div className="text-sm">
            <span className="text-[var(--muted)]">Tool servers</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {servers.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() =>
                    setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))
                  }
                  className={`chip ${picked.includes(s) ? "text-[var(--brand-ink)]" : "text-[var(--muted)]"}`}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="mono mt-2 text-xs text-[var(--muted)]">
              memory is attached automatically and is not listed here.
            </p>
          </div>

          <fieldset className="text-sm">
            <legend className="text-[var(--muted)]">Where it runs</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {PLACEMENT_OPTIONS.map((p) => (
                <label
                  key={p.id}
                  className={`chip cursor-pointer ${placement === p.id ? "text-[var(--brand-ink)]" : "text-[var(--muted)]"} ${canSetPlacement ? "" : "opacity-60"}`}
                >
                  <input
                    type="radio"
                    name="placement"
                    className="mr-1.5"
                    value={p.id}
                    checked={placement === p.id}
                    disabled={!canSetPlacement}
                    onChange={() => setPlacement(p.id)}
                  />
                  {p.label}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">
              {PLACEMENT_OPTIONS.find((p) => p.id === placement)?.help}
              {!canSetPlacement && " Only an admin can change this."}
            </p>
            {placement !== "hub" && (
              <details className="mt-3 rounded-lg border border-[var(--border)] p-3">
                <summary className="cursor-pointer text-xs text-[var(--muted)]">
                  What Claude Code receives ({localFiles.length}{" "}
                  {localFiles.length === 1 ? "file" : "files"} under <span className="mono">.claude/</span>)
                </summary>
                <div className="mt-3 space-y-3">
                  {localFiles.map((f) => (
                    <div key={f.path}>
                      <div className="mono text-xs text-[var(--brand-ink)]">{f.path}</div>
                      <pre className="mono mt-1 max-h-72 overflow-auto rounded bg-[var(--panel-inset)] p-3 text-xs whitespace-pre-wrap">
                        {f.content}
                      </pre>
                    </div>
                  ))}
                  <p className="text-xs text-[var(--muted)]">
                    Written by <span className="mono">scripts/sync-hub-agents.mjs</span> when a Claude
                    Code session starts. The files hold no credential: tools, memory and knowledge
                    are reached through <span className="mono">/api/mcp/agents/{agent.slug}</span>,
                    which the hub checks on every call. Save first — the preview shows the saved agent.
                  </p>
                </div>
              </details>
            )}
            {localActivity && agent.placement !== "hub" && (
              <p className="mono mt-2 text-xs text-[var(--muted)]">
                Local use, last 30 days: {localActivity.calls} tool{" "}
                {localActivity.calls === 1 ? "call" : "calls"}
                {localActivity.failed > 0 && ` (${localActivity.failed} refused or failed)`} by{" "}
                {localActivity.people} {localActivity.people === 1 ? "person" : "people"}
                {localActivity.lastAt && ` · last ${new Date(localActivity.lastAt).toLocaleString()}`}
              </p>
            )}
          </fieldset>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>

          <div className="flex items-center gap-3">
            <button className="btn-brand" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={remove} disabled={saving}>
              Delete agent
            </button>
            {saveMsg && <span className="text-sm text-[var(--muted)]">{saveMsg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
