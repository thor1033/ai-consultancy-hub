"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ContextSnapshot, MemoryRegion } from "@ai-hub/db";
import {
  CORE,
  KNOWLEDGE_BOX,
  REGIONS,
  VIEW,
  cascades,
  network,
  placer,
  inferRegion,
  layoutLabels,
  stipple,
  type Firing,
  type Region,
} from "./brain";
import { setContextMemoryActiveAction, setContextMemoryRegionAction } from "./actions";

type Kind = "memory" | "skill" | "source" | "person" | "rules";
type Shape = "square" | "diamond" | "outline" | "circle";

const KINDS: Record<Kind, { label: string; color: string; shape: Shape }> = {
  memory: { label: "Memory", color: "var(--c-mem)", shape: "square" },
  skill: { label: "Skill", color: "var(--c-skill)", shape: "diamond" },
  source: { label: "Live source", color: "var(--c-src)", shape: "outline" },
  person: { label: "Person", color: "var(--c-person)", shape: "circle" },
  rules: { label: "Rules", color: "var(--c-rules)", shape: "square" },
};

const REGION_ORDER: Region[] = ["projects", "people", "rules", "routines"];
const REGION_NAME: Record<Region, string> = {
  projects: "Projects",
  people: "People",
  rules: "Rules",
  routines: "Routines",
};

const MAX_FIRING = 9;
const STIPPLE = 650;

interface Item {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  label: string;
  on: boolean;
  agentId?: string;
  memoryKey?: string;
  region?: MemoryRegion | null;
}

interface Detail {
  kindLabel: string;
  color: string;
  title: string;
  tags: string[];
  body: string;
  facts: { k: string; v: string }[];
  memory?: { agentId: string; key: string; active: boolean; region: MemoryRegion | null };
}

function rel(iso: string | null, now: string): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.parse(now) - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return iso.slice(0, 10);
}

const trim = (text: string, n: number) => (text.length > n ? text.slice(0, n).trimEnd() + "…" : text);

function swatchStyle(shape: Shape, color: string): React.CSSProperties {
  const base: React.CSSProperties = { display: "inline-block", flexShrink: 0 };
  if (shape === "circle") return { ...base, width: 10, height: 10, borderRadius: "50%", background: color };
  if (shape === "diamond") return { ...base, width: 8, height: 8, transform: "rotate(45deg)", background: color };
  if (shape === "outline") return { ...base, width: 10, height: 10, boxSizing: "border-box", border: `2.5px solid ${color}` };
  return { ...base, width: 10, height: 10, background: color };
}

export function ContextView({ snapshot, canManage }: { snapshot: ContextSnapshot; canManage: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  const points = useMemo(() => stipple(STIPPLE), []);
  const net = useMemo(() => network(points), [points]);

  const agentName = useMemo(() => {
    const m = new Map(snapshot.agents.map((a) => [a.id, a.name]));
    return (id: string) => m.get(id) ?? "Unknown agent";
  }, [snapshot.agents]);

  const view = useMemo(() => {
    const inScope = (agentId: string) => filter === "all" || agentId === filter;
    const place = placer();
    const items: Item[] = [];

    const memories = snapshot.memories.filter((m) => inScope(m.agentId));
    for (const m of memories) {
      const pos = place(m.region ?? inferRegion(m.key, m.content));
      items.push({
        id: `mem:${m.agentId}:${m.key}`,
        kind: "memory",
        ...pos,
        label: m.key,
        on: m.active,
        agentId: m.agentId,
        memoryKey: m.key,
        region: m.region,
      });
    }
    for (const s of snapshot.servers.filter((s) => s.usedBy.some(inScope))) {
      items.push({ id: `src:${s.name}`, kind: "source", ...place("projects"), label: s.label || s.name, on: s.enabled });
    }
    for (const k of snapshot.skills.filter((k) => inScope(k.agentId))) {
      items.push({ id: `skill:${k.id}`, kind: "skill", ...place("routines"), label: k.slug, on: k.enabled, agentId: k.agentId });
    }
    for (const a of snapshot.agents.filter((a) => inScope(a.id) && a.brief.trim())) {
      items.push({ id: `brief:${a.id}`, kind: "rules", ...place("rules"), label: `${a.slug} brief`, on: a.enabled, agentId: a.id });
    }
    if (filter === "all") {
      for (const p of snapshot.people) {
        items.push({ id: `person:${p.id}`, kind: "person", ...place("people"), label: p.name, on: p.enabled });
      }
    }

    const firing: Firing[] = items
      .filter((i) => i.on && i.kind !== "person" && i.kind !== "rules")
      .slice(0, MAX_FIRING)
      .map((i) => ({ x: i.x, y: i.y, color: KINDS[i.kind].color }));
    const { signals, spikes } = cascades(net, firing);

    const tinters = items
      .filter((i) => i.on && i.kind !== "rules")
      .map((i) => ({ x: i.x, y: i.y, color: KINDS[i.kind].color }));
    const ink = points.map((p) => {
      let near: (typeof tinters)[number] | null = null;
      let nd = Infinity;
      for (const t of tinters) {
        const d = Math.hypot(p.x - t.x, p.y - t.y);
        if (d < nd) {
          nd = d;
          near = t;
        }
      }
      const tinted = near !== null && nd < 72;
      const s = tinted ? 1.8 + p.j * 1.2 : 1.6 + p.j * 0.9;
      return {
        x: p.x - s / 2,
        y: p.y - s / 2,
        s,
        fill: tinted ? near!.color : "var(--text)",
        op: tinted ? 0.3 + 0.5 * (1 - nd / 72) : 0.1 + p.j * 0.16,
      };
    });

    const loaded = memories.filter((m) => m.active).length;
    return { items, signals, spikes, ink, loaded, aside: memories.length - loaded, autoFiled: memories.filter((m) => !m.region).length };
  }, [filter, snapshot, points, net]);

  const labels = useMemo(
    () =>
      layoutLabels(
        view.items.map((i, n) => ({
          id: i.id,
          x: i.x,
          y: i.y,
          text: trim(i.label, 26),
          priority: i.id === selected ? -1 : i.kind === "memory" ? 10 + n : n,
        })),
        view.items,
      ),
    [view.items, selected],
  );

  const detail: Detail | null = useMemo(() => {
    if (!selected) return null;
    const [kind, ...rest] = selected.split(":");
    if (kind === "mem") {
      const agentId = rest[0];
      const key = rest.slice(1).join(":");
      const m = snapshot.memories.find((x) => x.agentId === agentId && x.key === key);
      if (!m) return null;
      return {
        kindLabel: m.active ? "Memory · loaded" : "Memory · set aside",
        color: m.active ? KINDS.memory.color : "var(--muted)",
        title: m.key,
        tags: [agentName(m.agentId), m.region ? REGION_NAME[m.region] : `${REGION_NAME[inferRegion(m.key, m.content)]} · auto-filed`],
        body: m.content,
        facts: [
          { k: "Updated", v: rel(m.updatedAt, snapshot.takenAt) },
          { k: "Loaded at the start of a run", v: m.active ? "Yes" : "No — found by search" },
        ],
        memory: { agentId: m.agentId, key: m.key, active: m.active, region: m.region },
      };
    }
    if (kind === "src") {
      const s = snapshot.servers.find((x) => x.name === rest.join(":"));
      if (!s) return null;
      return {
        kindLabel: "Live source",
        color: KINDS.source.color,
        title: s.label || s.name,
        tags: s.usedBy.map(agentName),
        body: s.description || "A tool the agents read live on every run.",
        facts: [
          { k: "Server", v: s.name },
          { k: "State", v: s.enabled ? "Enabled" : "Disabled in the control plane" },
        ],
      };
    }
    if (kind === "skill") {
      const k = snapshot.skills.find((x) => x.id === rest.join(":"));
      if (!k) return null;
      return {
        kindLabel: "Skill",
        color: KINDS.skill.color,
        title: k.name,
        tags: [agentName(k.agentId)],
        body: k.description,
        facts: [
          { k: "Tool", v: `hub_skill_${k.slug.replace(/-/g, "_")}` },
          { k: "State", v: k.enabled ? "Enabled" : "Disabled" },
        ],
      };
    }
    if (kind === "brief") {
      const a = snapshot.agents.find((x) => x.id === rest.join(":"));
      if (!a) return null;
      return {
        kindLabel: "Rules · standing brief",
        color: KINDS.rules.color,
        title: `${a.name}'s brief`,
        tags: [a.name],
        body: trim(a.brief, 900),
        facts: [
          { k: "Length", v: `${a.brief.length.toLocaleString("en")} characters` },
          { k: "Loaded", v: "In full, every run" },
        ],
      };
    }
    if (kind === "person") {
      const p = snapshot.people.find((x) => x.id === rest.join(":"));
      if (!p) return null;
      return {
        kindLabel: "Person",
        color: KINDS.person.color,
        title: p.name,
        tags: p.roles.length ? p.roles : ["No role"],
        body: p.email,
        facts: [{ k: "Access", v: p.enabled ? "Enabled" : "Disabled" }],
      };
    }
    return null;
  }, [selected, snapshot, agentName]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setActionError(null);
    startTransition(async () => {
      const res = await fn();
      if (res.error) setActionError(res.error);
      router.refresh();
    });
  }

  const totals = useMemo(() => {
    const loaded = snapshot.memories.filter((m) => m.active).length;
    return {
      loaded,
      aside: snapshot.memories.length - loaded,
      sources: snapshot.servers.filter((s) => s.enabled).length,
    };
  }, [snapshot]);

  const gaps = useMemo(() => {
    const out: { title: string; detail: string; color: string }[] = [];
    if (snapshot.knowledge.documents === 0) {
      out.push({
        title: "Knowledge base is empty.",
        detail: "No documents — agents answer from memory and live sources only.",
        color: "var(--brand)",
      });
    }
    for (const a of snapshot.agents) {
      const n = snapshot.memories.filter((m) => m.agentId === a.id).length;
      if (n === 0) out.push({ title: `${a.name} remembers nothing.`, detail: "Give it a job or retire it.", color: "var(--brand)" });
      else if (n === 1) out.push({ title: `${a.name} holds 1 memory.`, detail: "Thin context to start a run from.", color: "var(--text)" });
    }
    const failed = snapshot.activity.filter((e) => e.kind === "run" && e.status === "failed").length;
    if (failed) out.push({ title: `${failed} recent run${failed === 1 ? "" : "s"} failed.`, detail: "See the agent's runs for the error.", color: "var(--brand)" });
    for (const s of snapshot.schedules.filter((s) => s.lastError)) {
      out.push({ title: `Schedule "${s.name}" errored.`, detail: trim(s.lastError ?? "", 90), color: "var(--brand)" });
    }
    const untagged = snapshot.memories.filter((m) => !m.region).length;
    if (untagged) {
      out.push({
        title: `${untagged} ${untagged === 1 ? "memory was" : "memories were"} filed automatically.`,
        detail: "Placed by what they say — tap one to confirm or move it.",
        color: "var(--faint)",
      });
    }
    return out;
  }, [snapshot]);

  const filters = [{ id: "all", name: "Whole workspace" }, ...snapshot.agents.map((a) => ({ id: a.id, name: a.name }))];
  const focus = snapshot.agents.find((a) => a.id === filter);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow flex flex-wrap items-center gap-4">
            <span>Context</span>
            <span className="inline-flex items-center gap-2 text-[var(--ai)]">
              <span className="ctx-blink inline-block h-2 w-2 bg-[var(--ai)]" />
              Live
            </span>
            <span>{new Date(snapshot.takenAt).toUTCString().slice(5, 22)} UTC</span>
          </div>
          <h1 className="mt-3 text-3xl md:text-4xl">
            What the workspace knows <span className="text-[var(--brand)]">right now.</span>
          </h1>
        </div>
        <div role="group" aria-label="Show context for" className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setSelected(null);
              }}
              className={`min-h-11 border px-3.5 text-[0.6875rem] font-medium uppercase tracking-[0.18em] transition-colors ${
                filter === f.id
                  ? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)] hover:border-[var(--brand)] hover:bg-[var(--brand)]"
                  : "border-[var(--border-strong)] text-[var(--text-soft)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
              }`}
            >
              {f.name}
            </button>
          ))}
        </div>
      </header>

      <div className="rule-heavy grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { value: snapshot.agents.length, label: "Agents" },
          { value: totals.loaded, label: "Memories loaded", node: "var(--c-mem)" },
          { value: totals.aside, label: "Set aside" },
          { value: snapshot.knowledge.documents, label: "Documents", node: snapshot.knowledge.documents ? undefined : "var(--brand)" },
          { value: snapshot.skills.length, label: "Skills", node: "var(--c-skill)" },
          { value: totals.sources, label: "Live sources", node: "var(--c-src)" },
        ].map((s) => (
          <div key={s.label} className="border-b border-[var(--border)] py-3.5 pr-4">
            <div className="metric flex items-center gap-2 text-3xl font-bold">
              {s.node && <span className="inline-block h-2.5 w-2.5" style={{ background: s.node }} />}
              {s.value}
            </div>
            <div className="eyebrow mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-stretch gap-5">
        <section aria-label="Context map" className="panel flex min-w-0 flex-[999_1_640px] flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
            <div className="eyebrow">{focus ? `${focus.name} — context map` : "Whole workspace — context map"}</div>
            <div className="flex flex-wrap gap-4 text-xs text-[var(--text-soft)]">
              {(Object.keys(KINDS) as Kind[]).map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5">
                  <span style={swatchStyle(KINDS[k].shape, KINDS[k].color)} />
                  {KINDS[k].label}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-[7px] w-[7px] border-[1.5px] border-[var(--faint)]" />
                Set aside
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 border-[1.5px] border-dashed border-[var(--brand)]" />
                Gap
              </span>
            </div>
          </div>

          <svg
            viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
            className="block h-auto w-full"
            role="img"
            aria-label={`Context map: ${view.items.length} pieces of context, ${view.loaded} memories loaded, ${view.aside} set aside`}
          >
            <g>
              {view.ink.map((p, i) => (
                <rect key={i} x={p.x} y={p.y} width={p.s} height={p.s} style={{ fill: p.fill, opacity: p.op }} />
              ))}
            </g>
            <g>
              {net.edges.map(([a, b], i) => (
                <line
                  key={i}
                  x1={net.neurons[a].x}
                  y1={net.neurons[a].y}
                  x2={net.neurons[b].x}
                  y2={net.neurons[b].y}
                  style={{ stroke: "var(--text)", strokeWidth: 0.7, opacity: 0.13 }}
                />
              ))}
              {net.neurons.map((n, i) => (
                <rect key={i} x={n.x - 1.8} y={n.y - 1.8} width={3.6} height={3.6} style={{ fill: "var(--text)", opacity: 0.38 }} />
              ))}
            </g>

            <rect
              x={KNOWLEDGE_BOX.x}
              y={KNOWLEDGE_BOX.y}
              width={KNOWLEDGE_BOX.w}
              height={KNOWLEDGE_BOX.h}
              style={{
                fill: "var(--panel)",
                stroke: snapshot.knowledge.documents ? "var(--faint)" : "var(--brand)",
                strokeWidth: 1.2,
                strokeDasharray: snapshot.knowledge.documents ? undefined : "4 4",
              }}
            />
            <text
              x={KNOWLEDGE_BOX.x + KNOWLEDGE_BOX.w / 2}
              y={KNOWLEDGE_BOX.y + 34}
              textAnchor="middle"
              style={{ fill: snapshot.knowledge.documents ? "var(--muted)" : "var(--brand)", fontSize: 11, fontWeight: 500, letterSpacing: "0.2em" }}
            >
              KNOWLEDGE
            </text>
            <text
              x={KNOWLEDGE_BOX.x + KNOWLEDGE_BOX.w / 2}
              y={KNOWLEDGE_BOX.y + 52}
              textAnchor="middle"
              style={{ fill: snapshot.knowledge.documents ? "var(--text)" : "var(--brand)", fontSize: 11, fontWeight: 500, letterSpacing: "0.2em" }}
            >
              {snapshot.knowledge.documents ? `${snapshot.knowledge.documents} DOCS` : "EMPTY"}
            </text>

            <g>
              {view.items
                .filter((i) => i.on && i.kind !== "person")
                .map((i) => (
                  <line
                    key={i.id}
                    x1={CORE.x}
                    y1={CORE.y}
                    x2={i.x}
                    y2={i.y}
                    style={{ stroke: KINDS[i.kind].color, strokeWidth: 1, opacity: i.kind === "rules" ? 0.25 : 0.3 }}
                  />
                ))}
            </g>

            <g aria-hidden="true">
              {view.signals.map((s, i) => (
                <line
                  key={i}
                  className="ctx-sig"
                  pathLength={1}
                  x1={s.x1}
                  y1={s.y1}
                  x2={s.x2}
                  y2={s.y2}
                  style={{ stroke: s.color, strokeWidth: 2.6, strokeLinecap: "square", opacity: 0.95, animationDelay: s.delay }}
                />
              ))}
              {view.spikes.map((s, i) => (
                <g key={i}>
                  {s.burst && (
                    <rect
                      className="ctx-burst"
                      x={s.x - 3}
                      y={s.y - 3}
                      width={6}
                      height={6}
                      style={{ fill: "none", stroke: s.color, strokeWidth: 1, animationDelay: s.delay }}
                    />
                  )}
                  <rect
                    className="ctx-halo"
                    x={s.x - s.hs / 2}
                    y={s.y - s.hs / 2}
                    width={s.hs}
                    height={s.hs}
                    style={{ fill: s.color, animationDelay: s.delay }}
                  />
                  <rect
                    className="ctx-spike"
                    x={s.x - s.s / 2}
                    y={s.y - s.s / 2}
                    width={s.s}
                    height={s.s}
                    style={{ fill: s.color, animationDelay: s.delay }}
                  />
                </g>
              ))}
            </g>

            <rect className="ctx-core" x={CORE.x - 9} y={CORE.y - 9} width={18} height={18} style={{ fill: "none", stroke: "var(--ai)", strokeWidth: 1.2 }} />
            <rect x={CORE.x - 9} y={CORE.y - 9} width={18} height={18} style={{ fill: "var(--ai)" }} />
            <text x={CORE.x} y={CORE.y + 32} textAnchor="middle" style={{ fill: "var(--text)", fontSize: 14, fontWeight: 700 }}>
              {focus ? focus.name : "Workspace"}
            </text>

            {view.items.map((i) => {
              const k = KINDS[i.kind];
              const isSel = selected === i.id;
              const size = k.shape === "diamond" ? 10 : i.on ? 12 : 10;
              const fill =
                i.kind === "memory"
                  ? i.on
                    ? k.color
                    : "var(--panel)"
                  : k.shape === "outline"
                    ? "var(--panel)"
                    : k.color;
              const stroke =
                i.kind === "memory" && !i.on ? "var(--faint)" : k.shape === "outline" ? k.color : "none";
              const strokeWidth = k.shape === "outline" ? 3 : 1.5;
              const opacity = i.kind !== "memory" && !i.on ? 0.4 : 1;
              const label = labels.get(i.id);
              const shapeStyle = { fill, stroke, strokeWidth, opacity, cursor: "pointer" };
              return (
                <g
                  key={i.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${k.label}: ${i.label}`}
                  aria-pressed={isSel}
                  onClick={() => setSelected(i.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(i.id);
                    }
                  }}
                  style={{ outline: "none" }}
                >
                  <rect x={i.x - 14} y={i.y - 14} width={28} height={28} style={{ fill: "transparent" }} />
                  {k.shape === "circle" ? (
                    <circle cx={i.x} cy={i.y} r={6} style={shapeStyle} />
                  ) : (
                    <rect
                      x={i.x - size / 2}
                      y={i.y - size / 2}
                      width={size}
                      height={size}
                      transform={k.shape === "diamond" ? `rotate(45 ${i.x} ${i.y})` : undefined}
                      style={shapeStyle}
                    />
                  )}
                  {isSel && (
                    <rect x={i.x - 12} y={i.y - 12} width={24} height={24} style={{ fill: "none", stroke: "var(--brand)", strokeWidth: 1.5 }} />
                  )}
                  {label && (
                    <text
                      x={label.x}
                      y={label.y}
                      textAnchor={label.anchor}
                      className="mono"
                      style={{ fill: i.on ? "var(--text)" : "var(--muted)", fontSize: 12, cursor: "pointer" }}
                    >
                      {trim(i.label, 26)}
                    </text>
                  )}
                </g>
              );
            })}

            {REGION_ORDER.map((r) => (
              <text
                key={r}
                x={REGIONS[r].lx}
                y={REGIONS[r].ly}
                textAnchor={REGIONS[r].anchor}
                style={{ fill: "var(--muted)", fontSize: 11, fontWeight: 500, letterSpacing: "0.3em" }}
              >
                {REGIONS[r].label}
              </text>
            ))}
          </svg>

          <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-[var(--muted)]">
            <span>Tap any point to read it</span>
            {view.autoFiled > 0 && <span>{view.autoFiled} filed automatically — tap one to confirm or move it</span>}
          </div>
        </section>

        <section aria-labelledby="ctx-detail" className="panel flex min-w-0 flex-[1_1_320px] flex-col gap-3.5 p-5">
          {detail ? (
            <>
              <div className="eyebrow flex items-center gap-2" style={{ color: detail.color }}>
                <span className="inline-block h-2 w-2" style={{ background: detail.color }} />
                {detail.kindLabel}
              </div>
              <h2 id="ctx-detail" className="mono break-words text-lg font-medium tracking-normal">
                {detail.title}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {detail.tags.map((t) => (
                  <span
                    key={t}
                    className="border border-[var(--border-strong)] px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-[var(--text-soft)]"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <p className="whitespace-pre-line text-[0.95rem] leading-relaxed">{detail.body.replace(/([^\n])\n(?!\n)/g, "$1 ")}</p>
              <div className="mt-auto flex flex-col">
                {detail.facts.map((f) => (
                  <div key={f.k} className="flex justify-between gap-3 border-t border-[var(--border)] py-2 text-[0.8rem]">
                    <span className="text-[var(--muted)]">{f.k}</span>
                    <span className="mono text-right text-xs text-[var(--text-soft)]">{f.v}</span>
                  </div>
                ))}
                {detail.memory && canManage && (
                  <div className="mt-3 flex flex-col gap-3">
                    <div>
                      <div className="eyebrow mb-2">File under</div>
                      <div className="flex flex-wrap gap-1.5">
                        {REGION_ORDER.map((r) => (
                          <button
                            key={r}
                            type="button"
                            disabled={pending}
                            aria-pressed={detail.memory!.region === r}
                            onClick={() => run(() => setContextMemoryRegionAction(detail.memory!.agentId, detail.memory!.key, r))}
                            className={`min-h-11 border px-3 text-[0.6875rem] font-medium uppercase tracking-[0.18em] transition-colors disabled:opacity-45 ${
                              detail.memory!.region === r
                                ? "border-[var(--text)] bg-[var(--text)] text-[var(--bg)]"
                                : "border-[var(--border-strong)] text-[var(--text-soft)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
                            }`}
                          >
                            {REGION_NAME[r]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn min-h-11 uppercase tracking-[0.18em]"
                      disabled={pending}
                      onClick={() =>
                        run(() => setContextMemoryActiveAction(detail.memory!.agentId, detail.memory!.key, !detail.memory!.active))
                      }
                    >
                      {detail.memory.active ? "Set aside" : "Load again"}
                    </button>
                  </div>
                )}
                {actionError && <p className="mt-2 text-sm text-[var(--danger)]">{actionError}</p>}
              </div>
            </>
          ) : (
            <>
              <div className="eyebrow">Nothing selected</div>
              <h2 id="ctx-detail" className="text-xl">
                Tap a point on the map
              </h2>
              <p className="text-[var(--text-soft)]">
                Every point is something an agent holds or can reach: its memories, skills, live sources, standing brief and the
                people it works for. Pick one to read exactly what it says.
              </p>
            </>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <section aria-labelledby="ctx-agents" className="panel p-5">
          <div className="eyebrow">Agents</div>
          <h2 id="ctx-agents" className="mb-2 mt-2 text-xl">
            What each one starts from
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[280px] border-collapse text-sm">
              <thead>
                <tr className="whitespace-nowrap text-left text-[0.6875rem] uppercase tracking-[0.12em] text-[var(--muted)]">
                  <th scope="col" className="py-2 pr-2 font-medium">Agent</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Loaded</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Aside</th>
                  <th scope="col" className="py-2 pl-2 text-right font-medium">Ran</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.agents.map((a) => {
                  const mine = snapshot.memories.filter((m) => m.agentId === a.id);
                  const on = mine.filter((m) => m.active).length;
                  return (
                    <tr key={a.id} className="border-t border-[var(--border)]">
                      <td className="py-2.5 pr-2">{a.name}</td>
                      <td className="mono px-2 py-2.5 text-right" style={{ color: on ? "var(--c-mem)" : "var(--faint)" }}>
                        {on}
                      </td>
                      <td className="mono px-2 py-2.5 text-right text-[var(--muted)]">{mine.length - on}</td>
                      <td className="mono whitespace-nowrap py-2.5 pl-2 text-right text-[var(--faint)]">{rel(a.lastRunAt, snapshot.takenAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="ctx-activity" className="panel flex flex-col p-5">
          <div className="eyebrow">Activity</div>
          <h2 id="ctx-activity" className="mb-2 mt-2 text-xl">
            Recently
          </h2>
          {snapshot.activity.length === 0 && <p className="text-sm text-[var(--muted)]">Nothing has happened yet.</p>}
          {snapshot.activity.map((e, i) => (
            <div key={i} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 border-t border-[var(--border)] py-2.5 text-[0.8rem]">
              <span className="mono text-xs text-[var(--faint)]">{rel(e.at, snapshot.takenAt)}</span>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="inline-block h-[7px] w-[7px] shrink-0 bg-[var(--c-mem)]" />
                <span className="shrink-0 text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-[var(--c-mem)]">
                  {e.kind === "run" ? "Run" : "Memory"}
                </span>
                <span className="min-w-0 text-[var(--text-soft)]">
                  {agentName(e.agentId)} · {e.title}
                  {e.status && e.status !== "succeeded" && (
                    <span className={e.status === "failed" ? "text-[var(--danger)]" : "text-[var(--muted)]"}> · {e.status}</span>
                  )}
                </span>
              </span>
            </div>
          ))}
        </section>

        <section aria-labelledby="ctx-gaps" className="panel flex flex-col p-5">
          <div className="eyebrow text-[var(--brand)]">Needs attention</div>
          <h2 id="ctx-gaps" className="mb-2 mt-2 text-xl">
            Gaps
          </h2>
          {gaps.length === 0 && <p className="text-sm text-[var(--muted)]">Nothing stands out.</p>}
          {gaps.map((g) => (
            <div key={g.title} className="flex items-baseline gap-2.5 border-t border-[var(--border)] py-2.5 text-sm leading-snug">
              <span className="inline-block h-2 w-2 shrink-0 -translate-y-px" style={{ background: g.color }} />
              <span>
                <span className="font-bold">{g.title}</span> <span className="text-[var(--muted)]">{g.detail}</span>
              </span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
