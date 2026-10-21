"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAgentAction, deleteAgentAction } from "./actions";
import { MODELS, agentToolName } from "./models";
import type { ToolOption } from "./catalog";

// One form for hiring an agent and for changing one, in the order a person
// thinks about a new hire: who it is, its brief, what it may use, what it may
// read, and how hard it may work. The preview beside it shows what the rest of
// the hub — and every connected client — will see.

export interface AgentFormValues {
  id: string | null;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  knowledgeCollection: string;
  maxIterations: string;
  servers: string[];
  enabled: boolean;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export function AgentForm({
  initial,
  tools,
  collections,
  defaultMaxIterations,
  maxIterationsCeiling,
}: {
  initial: AgentFormValues;
  tools: ToolOption[];
  collections: string[];
  defaultMaxIterations: number;
  maxIterationsCeiling: number;
}) {
  const router = useRouter();
  const creating = initial.id === null;
  const [v, setV] = useState<AgentFormValues>(initial);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const set = <K extends keyof AgentFormValues>(k: K, value: AgentFormValues[K]) => {
    setV((prev) => ({ ...prev, [k]: value }));
    setMessage(null);
  };

  const slug = creating ? slugify(v.name) : v.slug;
  const toolName = agentToolName(slug || "your-agent");
  const picked = tools.filter((t) => v.servers.includes(t.name));
  const words = v.instructions.trim() ? v.instructions.trim().split(/\s+/).length : 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await saveAgentAction(v.id, {
        slug: creating ? v.name : v.slug,
        name: v.name,
        description: v.description,
        instructions: v.instructions,
        model: v.model || null,
        knowledgeCollection: v.knowledgeCollection || null,
        maxIterations: v.maxIterations.trim() === "" ? null : Number(v.maxIterations),
        mcpServers: v.servers.map((name) => ({ name })),
        enabled: v.enabled,
      });
      if ("error" in res) {
        setMessage({ text: res.error, error: true });
        return;
      }
      if (creating) router.push(`/agents/${res.slug}`);
      else {
        setMessage({ text: "Saved.", error: false });
        router.refresh();
      }
    });
  }

  function remove() {
    start(async () => {
      const res = await deleteAgentAction(v.id!);
      if (!res.ok) {
        setMessage({ text: res.error ?? "Could not delete the agent.", error: true });
        setConfirmDelete(false);
        return;
      }
      router.push("/agents");
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
        <Section n="01" title="Who it is" hint="The name and one-line purpose every connected client shows in its tool list.">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--muted)]">Name</span>
              <input className="field" required value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="Delivery Lead" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--muted)]">What it is for</span>
              <input
                className="field"
                value={v.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Tracks client delivery and says what is late"
              />
            </label>
          </div>
          {!creating && (
            <label className="mt-4 flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-[var(--text)]" checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} />
              <span>
                <span className="font-medium">On</span>
                <span className="text-[var(--muted)]"> — switched off, it is hidden from clients and cannot be run or scheduled.</span>
              </span>
            </label>
          )}
        </Section>

        <Section
          n="02"
          title="Its brief"
          hint="Loaded in full at the start of every run. Say who it works for, what it may and may not do, and which tools to reach for first."
        >
          <textarea
            className="field min-h-72 resize-y leading-relaxed"
            value={v.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder={
              "You are the delivery lead at Teqneo.\n\nCheck your memory first. Use pm-tool for live project state — never guess a status.\n\nYou may read the board; you may not change it. When something is late, say what it blocks."
            }
          />
          <div className="mt-1.5 text-xs text-[var(--muted)]">{words ? `${words} words` : "Empty — the agent runs on its tools and memory alone."}</div>
        </Section>

        <Section n="03" title="What it may use" hint="Each tool is a live connection the agent can call while it works. Memory is always on.">
          <ul className="grid gap-2 sm:grid-cols-2">
            <li className="inset flex items-start gap-3 p-3.5 opacity-80">
              <input type="checkbox" checked disabled className="mt-0.5 h-4 w-4" aria-label="Memory, always on" />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span aria-hidden className="inline-block h-2 w-2 bg-[var(--c-mem)]" />
                  Memory
                </span>
                <span className="mt-0.5 block text-xs text-[var(--muted)]">Its own, kept between runs. Always attached.</span>
              </span>
            </li>
            {tools.map((t) => {
              const on = v.servers.includes(t.name);
              return (
                <li key={t.name}>
                  <label
                    className={`flex min-h-full cursor-pointer items-start gap-3 border p-3.5 transition-colors ${
                      on ? "border-[var(--text)] bg-[var(--panel)]" : "border-[var(--border-strong)] hover:border-[var(--brand)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-[var(--text)]"
                      checked={on}
                      onChange={() => set("servers", on ? v.servers.filter((s) => s !== t.name) : [...v.servers, t.name])}
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span aria-hidden className="inline-block h-2 w-2 border-2" style={{ borderColor: "var(--c-src)" }} />
                        {t.label}
                        {t.label !== t.name && <span className="mono text-xs font-normal text-[var(--muted)]">{t.name}</span>}
                      </span>
                      {t.description && <span className="mt-0.5 block text-xs text-[var(--muted)]">{t.description}</span>}
                      {!t.available && (
                        <span className="mt-1 block text-xs font-medium text-[var(--warning)]">Unavailable on this deployment</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section
          n="04"
          title="What it may read"
          hint="Scope its knowledge to one collection. It still only reads what the person asking may read."
        >
          <select className="field max-w-md" value={v.knowledgeCollection} onChange={(e) => set("knowledgeCollection", e.target.value)}>
            <option value="">No knowledge — memory and tools only</option>
            {collections.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {collections.length === 0 && (
            <p className="mt-2 text-xs text-[var(--muted)]">
              No collections yet — file documents into one on the Knowledge page.
            </p>
          )}
        </Section>

        <Section n="05" title="How it works" hint="The model it thinks with, and how many rounds of tool use one run may take before it stops and says so.">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--muted)]">Model</span>
              <select className="field" value={v.model} onChange={(e) => set("model", e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.note}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--muted)]">Tool rounds per run</span>
              <input
                className="field mono"
                type="number"
                min={1}
                max={maxIterationsCeiling}
                value={v.maxIterations}
                placeholder={`${defaultMaxIterations} (default)`}
                onChange={(e) => set("maxIterations", e.target.value)}
              />
              <span className="mt-1 block text-xs text-[var(--muted)]">
                Up to {maxIterationsCeiling}. Raise it for an agent that works through a queue.
              </span>
            </label>
          </div>
        </Section>

        {!creating && (
          <section className="border border-[var(--danger)] p-5" aria-labelledby="danger-title">
            <h3 id="danger-title" className="text-base font-bold text-[var(--danger)]">
              Delete this agent
            </h3>
            <p className="mt-1 text-sm text-[var(--text-soft)]">
              Its memories, skills and schedules go with it. Clients lose its tools at once. This cannot be undone.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {confirmDelete ? (
                <>
                  <button type="button" onClick={remove} disabled={pending} className="btn min-h-11 border-[var(--danger)] text-[var(--danger)]">
                    {pending ? "Deleting…" : `Delete ${v.name}`}
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="btn min-h-11">
                    Keep it
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmDelete(true)} className="btn min-h-11 border-[var(--danger)] text-[var(--danger)]">
                  Delete agent…
                </button>
              )}
            </div>
          </section>
        )}
      </div>

      <aside className="flex min-w-0 flex-[1_1_280px] flex-col gap-4 lg:sticky lg:top-6">
        <div className="panel p-5">
          <div className="eyebrow">{creating ? "Preview" : "As clients see it"}</div>
          <div className="mt-3 flex items-center gap-2.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5" style={{ background: v.enabled ? "var(--ai)" : "var(--faint)" }} />
            <span className="text-xl font-bold">{v.name || "Unnamed agent"}</span>
          </div>
          <p className="mt-1 text-sm text-[var(--text-soft)]">{v.description || "No description yet."}</p>
          <dl className="mt-4 flex flex-col text-sm">
            <Row k="Tool">
              <span className="mono break-all text-xs">{toolName}</span>
            </Row>
            <Row k="Brief">{words ? `${words} words` : "None"}</Row>
            <Row k="Tools">{picked.length ? picked.map((t) => t.label).join(", ") : "Memory only"}</Row>
            <Row k="Knowledge">{v.knowledgeCollection || "None"}</Row>
            <Row k="Model">{MODELS.find((m) => m.id === v.model)?.label ?? v.model}</Row>
          </dl>
          <button type="submit" disabled={pending || !v.name.trim()} className="btn-brand mt-5 min-h-11 w-full">
            {pending ? (creating ? "Creating…" : "Saving…") : creating ? "Create agent" : "Save changes"}
          </button>
          {message && (
            <p role={message.error ? "alert" : "status"} className={`mt-2 text-sm ${message.error ? "text-[var(--danger)]" : "text-[var(--ai)]"}`}>
              {message.text}
            </p>
          )}
        </div>
      </aside>
    </form>
  );
}

function Section({ n, title, hint, children }: { n: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="panel p-5">
      <div className="flex items-baseline gap-3">
        <span className="mono text-xs text-[var(--muted)]">{n}</span>
        <h2 className="text-lg">{title}</h2>
      </div>
      <p className="mb-4 mt-1 max-w-2xl text-sm text-[var(--muted)]">{hint}</p>
      {children}
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-t border-[var(--border)] py-2">
      <dt className="shrink-0 text-[var(--muted)]">{k}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
