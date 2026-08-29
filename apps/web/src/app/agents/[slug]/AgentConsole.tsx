"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Agent, AgentMemory } from "@ai-hub/db";
import {
  sendAgentMessageAction,
  saveAgentAction,
  deleteAgentAction,
  forgetMemoryAction,
  type AgentChatMessage,
} from "../actions";

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
}: {
  agent: Agent;
  memories: AgentMemory[];
  servers: string[];
  collections: string[];
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
  const [picked, setPicked] = useState<string[]>(serverNames(agent));
  const [enabled, setEnabled] = useState(agent.enabled);
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
        mcpServers: picked.map((n) => ({ name: n })),
        enabled,
      });
      setSaveMsg("error" in res ? res.error : "Saved.");
      if (!("error" in res)) router.refresh();
    });
  }

  function remove() {
    if (!confirm(`Delete ${agent.name}? Everything it remembers goes with it.`)) return;
    startSave(async () => {
      await deleteAgentAction(agent.id);
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

      {tab === "chat" && (
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
            <span className="mono">memory</span> server; delete any that are wrong or stale.
          </p>
          {memories.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Nothing remembered yet.</p>
          ) : (
            <ul className="space-y-3">
              {memories.map((m) => (
                <li key={m.id} className="rounded-lg border border-[var(--border)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="mono text-xs text-[var(--brand-ink)]">{m.key}</div>
                      <p className="mt-1 text-sm">{m.content}</p>
                    </div>
                    <button
                      className="btn shrink-0"
                      onClick={() =>
                        startSave(async () => {
                          await forgetMemoryAction(agent.id, m.key);
                          router.refresh();
                        })
                      }
                    >
                      Forget
                    </button>
                  </div>
                  <div className="mono mt-2 text-xs text-[var(--muted)]">
                    updated {new Date(m.updatedAt).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
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
