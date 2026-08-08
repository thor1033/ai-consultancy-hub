"use client";

import { useEffect, useRef, useState } from "react";
import { sendChatAction, type ChatMeta } from "./actions";

type Msg = { role: "user" | "assistant"; content: string; meta?: ChatMeta };

const SUGGESTIONS = [
  "What can you help me with here?",
  "Summarize this week's portfolio for Acme Family Office.",
  "Draft three talking points from our knowledge base.",
];

export function Chat({ skills, servers }: { skills: { slug: string; name: string }[]; servers: string[] }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skill, setSkill] = useState("");
  const [active, setActive] = useState<Set<string>>(new Set());
  const [useRag, setUseRag] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const toggleServer = (name: string) =>
    setActive((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: Msg[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    const res = await sendChatAction(
      next.map(({ role, content }) => ({ role, content })),
      { servers: [...active], skillSlug: skill || undefined, useRag },
    );
    if ("content" in res && typeof res.content === "string") {
      const reply: Msg = { role: "assistant", content: res.content, meta: res.meta };
      setMessages((m) => [...m, reply]);
    } else if ("error" in res && res.error) {
      setError(res.error);
    }
    setBusy(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-[var(--bg)]">
      {/* Header + config */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--panel-2)] px-4 py-2">
        <span className="text-sm font-semibold tracking-tight">Chat</span>
        <select value={skill} onChange={(e) => setSkill(e.target.value)} className="field h-8 max-w-[14rem] py-0 text-sm" title="Run as a Skill">
          <option value="">No skill (general)</option>
          {skills.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
        </select>
        <div className="flex flex-wrap items-center gap-1.5">
          {servers.map((name) => {
            const on = active.has(name);
            return (
              <button key={name} onClick={() => toggleServer(name)} title="Toggle MCP server"
                className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-[var(--brand-ink)] text-[var(--brand-ink)] bg-[var(--brand-soft)]" : "border-[var(--border)] text-[var(--muted)]"}`}>
                {name}
              </button>
            );
          })}
        </div>
        <button onClick={() => setUseRag((v) => !v)} title="Retrieve from the knowledge base"
          className={`rounded-full border px-2.5 py-1 text-xs ${useRag ? "border-[var(--brand-ink)] text-[var(--brand-ink)] bg-[var(--brand-soft)]" : "border-[var(--border)] text-[var(--muted)]"}`}>
          Knowledge (RAG)
        </button>
        <button onClick={() => { setMessages([]); setError(null); }} className="btn ml-auto h-8 py-0 text-xs">New chat</button>
      </div>

      {error && <div className="border-b border-[var(--border)] border-l-2 border-l-[var(--danger)] bg-[var(--panel)] px-4 py-2 text-sm text-[var(--danger)]">{error}</div>}

      {/* Thread */}
      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-4 py-6">
          {messages.length === 0 ? (
            <div className="mt-10 text-center">
              <p className="text-sm text-[var(--muted)]">A normal chat — powered by your Skills, MCP servers, and knowledge base.</p>
              <div className="mt-4 flex flex-col items-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--text)] hover:border-[var(--border-strong)]">{s}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {messages.map((m, i) => <Bubble key={i} msg={m} />)}
              {busy && <div className="text-sm text-[var(--muted)]">Thinking…</div>}
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
        <div className="mx-auto flex w-full max-w-[46rem] items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder="Message the hub…  (Enter to send, Shift+Enter for a new line)"
            className="field max-h-40 min-h-[2.5rem] flex-1 resize-none py-2 text-sm"
          />
          <button onClick={() => send(input)} disabled={busy || !input.trim()} className="btn-brand h-10 py-0 text-sm">
            {busy ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--brand-soft)] px-3.5 py-2 text-sm text-[var(--text)]">{msg.content}</div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%]">
        <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--panel)] px-3.5 py-2 text-sm text-[var(--text)]">{msg.content}</div>
        {msg.meta && <MetaLine meta={msg.meta} />}
      </div>
    </div>
  );
}

function MetaLine({ meta }: { meta: ChatMeta }) {
  const bits: string[] = [meta.model];
  if (meta.skill) bits.push(`skill: ${meta.skill}`);
  if (meta.servers.length) bits.push(meta.servers.join(", "));
  if (meta.toolsUsed.length) bits.push(`tools: ${meta.toolsUsed.join(", ")}`);
  if (meta.sources) bits.push(`${meta.sources} source${meta.sources === 1 ? "" : "s"}`);
  bits.push(`$${meta.costUsd.toFixed(4)}`);
  return <div className="mt-1 pl-1 text-[0.7rem] text-[var(--muted)]">{bits.join(" · ")}</div>;
}
