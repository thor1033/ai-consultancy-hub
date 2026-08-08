"use client";

import { useMemo, useState } from "react";
import { generateDeckAction, fillWithAiAction, saveTemplateAction, deleteTemplateAction } from "./actions";
import { SlideView, type Selection } from "./SlidePreview";
import { resolveTemplate } from "./preview";
import type { StudioTemplate } from "@/lib/pptxTemplates";

type Any = Record<string, unknown>;

function download(fileName: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

const toHex = (c: unknown) => { const s = typeof c === "string" ? c : ""; return s ? (s.startsWith("#") ? s : `#${s}`) : "#000000"; };
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);

// McKinsey-style palette (mirrors resolvePalette in the renderer/preview).
const INK = "#051C2C";
const ACCENT = "#2251FF";
const HAIRLINE = "#D6DCE4";
const SURFACE = "#F2F4F7";

// New-element factories (inches). Defaults land on the deck palette so anything
// inserted already looks consistent, not neon.
function newElement(type: string): Any {
  switch (type) {
    case "text": return { type: "text", x: 0.7, y: 0.6, w: 6, h: 0.7, text: "New text", fontSize: 20, color: INK };
    case "kpi": return { type: "kpi", x: 0.7, y: 0.6, w: 3.4, h: 1.15, label: "Metric", value: "00", caption: "caption", color: ACCENT };
    case "bullets": return { type: "bullets", x: 0.7, y: 0.6, w: 6, h: 3, items: ["First point", "Second point", "Third point"], fontSize: 15, color: INK };
    case "chart": return { type: "chart", x: 0.7, y: 0.6, w: 7, h: 4, chartType: "bar", title: "Chart", colors: [ACCENT, INK], series: [{ name: "Series 1", labels: ["A", "B", "C"], values: [4, 7, 3] }] };
    case "table": return { type: "table", x: 0.7, y: 0.6, w: 6, h: 2.5, fontSize: 13, rows: [["Header 1", "Header 2"], ["Row 1", "1"], ["Row 2", "2"]] };
    case "divider": return { type: "shape", shape: "line", x: 0.7, y: 0.9, w: 11.93, h: 0, line: HAIRLINE, lineWidth: 1.5 };
    case "band": return { type: "shape", shape: "rect", x: 0.7, y: 0.6, w: 4, h: 3, fill: SURFACE, radius: 0.04 };
    default: return { type: "text", x: 0.7, y: 0.6, w: 6, h: 0.7, text: "New text", color: INK };
  }
}
const blankSlide = (): Any => ({ background: "#FFFFFF", elements: [] });
const blankTemplate = (): Any => ({
  name: "Untitled", layout: "LAYOUT_WIDE",
  theme: { bg: "#FFFFFF", ink: INK, accent: ACCENT, hairline: HAIRLINE, surface: SURFACE },
  slides: [{
    background: INK,
    elements: [
      { type: "shape", shape: "rect", x: 0.7, y: 1.95, w: 1.25, h: 0.1, fill: ACCENT },
      { type: "text", x: 0.7, y: 2.2, w: 11, h: 0.35, text: "KICKER", fontSize: 13, bold: true, color: "#00A9F4", charSpacing: 2 },
      { type: "text", x: 0.7, y: 2.6, w: 12, h: 1.3, text: "Presentation title", fontSize: 44, bold: true, color: "#FFFFFF", fontFace: "Georgia" },
    ],
  }],
});

export function PptxStudio({ initialTemplates }: { initialTemplates: StudioTemplate[] }) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [selectedId, setSelectedId] = useState(initialTemplates[0]?.id ?? "");
  const selectedTpl = useMemo(() => templates.find((t) => t.id === selectedId), [templates, selectedId]);

  const [editableById, setEditableById] = useState<Record<string, Any>>(
    () => Object.fromEntries(initialTemplates.map((t) => [t.id, structuredClone(t.template) as Any])),
  );
  const editable = editableById[selectedId];

  const [valuesById, setValuesById] = useState<Record<string, string>>(
    () => Object.fromEntries(initialTemplates.map((t) => [t.id, t.prefill])),
  );
  const [parsedById, setParsedById] = useState<Record<string, Record<string, unknown>>>(
    () => Object.fromEntries(initialTemplates.map((t) => { try { return [t.id, JSON.parse(t.prefill)]; } catch { return [t.id, {}]; } })),
  );

  const [nameDraft, setNameDraft] = useState(initialTemplates[0]?.name ?? "");
  const [slideIdx, setSlideIdx] = useState(0);
  const [sel, setSel] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [aiContext, setAiContext] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [showData, setShowData] = useState(false);

  const valuesText = valuesById[selectedId] ?? "";
  const resolved = useMemo(
    () => (editable ? (resolveTemplate(editable, parsedById[selectedId] ?? {}) as Any) : null),
    [editable, parsedById, selectedId],
  );
  const slides = (editable?.slides as Any[] | undefined) ?? [];
  const resolvedSlides = (resolved?.slides as Any[] | undefined) ?? [];
  const curSlide = Math.min(slideIdx, Math.max(0, slides.length - 1));

  const selEl: Any | null = useMemo(() => {
    if (!editable || !sel || sel.e < 0) return null;
    return (slides[sel.s]?.elements as Any[] | undefined)?.[sel.e] ?? null;
  }, [editable, sel, slides]);

  // ---- template + editor state helpers ----
  function switchTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    setSelectedId(id); setNameDraft(t?.name ?? ""); setSlideIdx(0);
    setSel(null); setError(null); setDone(null); setAiNote(null); setSavedNote(null);
  }
  function mutate(fn: (t: Any) => void) {
    setEditableById((m) => { const t = structuredClone(m[selectedId]) as Any; fn(t); return { ...m, [selectedId]: t }; });
    setDone(null); setSavedNote(null);
  }
  function adoptTemplates(list: StudioTemplate[]) {
    setTemplates(list);
    setEditableById((m) => { const n = { ...m }; for (const t of list) if (!n[t.id]) n[t.id] = structuredClone(t.template) as Any; return n; });
    setValuesById((m) => { const n = { ...m }; for (const t of list) if (n[t.id] === undefined) n[t.id] = t.prefill; return n; });
    setParsedById((m) => { const n = { ...m }; for (const t of list) if (n[t.id] === undefined) { try { n[t.id] = JSON.parse(t.prefill); } catch { n[t.id] = {}; } } return n; });
  }

  // ---- element ops ----
  function patchSel(patch: Any) {
    if (!sel || sel.e < 0) return;
    mutate((t) => { Object.assign(((t.slides as Any[])[sel.s].elements as Any[])[sel.e], patch); });
  }
  function patchTheme(patch: Any) { mutate((t) => { t.theme = { ...(t.theme as Any), ...patch }; }); }
  function addElement(type: string) {
    const el = newElement(type);
    mutate((t) => { ((t.slides as Any[])[curSlide].elements as Any[]).push(el); });
    setSel({ s: curSlide, e: slides[curSlide].elements ? (slides[curSlide].elements as Any[]).length : 0 });
  }
  function deleteElement() {
    if (!sel || sel.e < 0) return;
    mutate((t) => { ((t.slides as Any[])[sel.s].elements as Any[]).splice(sel.e, 1); });
    setSel(null);
  }

  // ---- slide ops ----
  function addSlide() { mutate((t) => { (t.slides as Any[]).push(blankSlide()); }); setSlideIdx(slides.length); setSel(null); }
  function duplicateSlide() { mutate((t) => { const s = structuredClone((t.slides as Any[])[curSlide]); (t.slides as Any[]).splice(curSlide + 1, 0, s); }); setSlideIdx(curSlide + 1); setSel(null); }
  function deleteSlide() {
    if (slides.length <= 1) return;
    mutate((t) => { (t.slides as Any[]).splice(curSlide, 1); });
    setSlideIdx(Math.max(0, curSlide - 1)); setSel(null);
  }

  function newTemplate() {
    const id = `draft-${Date.now()}`;
    const tpl = blankTemplate();
    const studio: StudioTemplate = { id, name: "Untitled", slides: 1, fields: [], template: tpl, prefill: "{}", stored: false };
    setTemplates((t) => [...t, studio]);
    setEditableById((m) => ({ ...m, [id]: structuredClone(tpl) }));
    setValuesById((m) => ({ ...m, [id]: "{}" }));
    setParsedById((m) => ({ ...m, [id]: {} }));
    setSelectedId(id); setNameDraft("Untitled"); setSlideIdx(0); setSel(null); setSavedNote(null);
  }

  // ---- persistence + generation ----
  async function save() {
    if (!selectedTpl) return;
    setSaving(true); setError(null); setSavedNote(null);
    const currentValues = valuesText;
    const currentParsed = parsedById[selectedId] ?? {};
    const isNew = !selectedTpl.stored;
    const res = await saveTemplateAction(selectedId, nameDraft, JSON.stringify(editable), isNew);
    if ("error" in res) setError(res.error as string);
    else {
      const savedSpec = structuredClone(editable);
      adoptTemplates(res.templates as StudioTemplate[]);
      const newId = res.id as string;
      setEditableById((m) => ({ ...m, [newId]: savedSpec }));
      setValuesById((m) => ({ ...m, [newId]: currentValues }));
      setParsedById((m) => ({ ...m, [newId]: currentParsed }));
      setSelectedId(newId);
      setNameDraft((res.templates as StudioTemplate[]).find((t) => t.id === newId)?.name ?? nameDraft);
      setSavedNote("Saved");
    }
    setSaving(false);
  }
  async function remove() {
    if (!selectedTpl?.stored) return;
    const res = await deleteTemplateAction(selectedId);
    if ("error" in res) setError(res.error as string);
    else { const list = res.templates as StudioTemplate[]; adoptTemplates(list); switchTemplate(list[0]?.id ?? ""); }
  }
  async function fillWithAi() {
    if (!selectedTpl) return;
    setAiBusy(true); setError(null); setAiNote(null);
    const res = await fillWithAiAction(selectedTpl.id, aiContext);
    if ("error" in res && res.error) setError(res.error as string);
    else if ("valuesJson" in res) { setValues(res.valuesJson as string); setAiNote(`Filled by ${res.model} · $${(res.costUsd as number).toFixed(4)}`); }
    setAiBusy(false);
  }
  async function generate() {
    if (!selectedTpl) return;
    setBusy(true); setError(null); setDone(null);
    const res = await generateDeckAction(selectedTpl.id, valuesText, JSON.stringify(editable));
    if ("error" in res) setError(res.error as string);
    else { download(res.fileName, res.base64); setDone(`Downloaded ${res.fileName}`); }
    setBusy(false);
  }
  function setValues(text: string) {
    setValuesById((v) => ({ ...v, [selectedId]: text }));
    try { setParsedById((p) => ({ ...p, [selectedId]: JSON.parse(text) })); } catch { /* keep last valid */ }
  }

  if (!selectedTpl || !editable) {
    return <div className="grid h-[100dvh] place-items-center text-sm text-[var(--muted)]">No templates available.</div>;
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-[var(--bg)]">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel-2)] px-4 py-2">
        <span className="text-sm font-semibold tracking-tight">PowerPoint Studio</span>
        <select value={selectedId} onChange={(e) => switchTemplate(e.target.value)} className="field h-8 max-w-[16rem] py-0 text-sm">
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.stored ? "" : " · starter/draft"}</option>)}
        </select>
        <button onClick={newTemplate} className="btn h-8 py-0 text-xs">+ New</button>
        <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className="field h-8 w-48 py-0 text-sm" placeholder="Template name" />
        <div className="ml-auto flex items-center gap-2">
          {savedNote && <span className="text-xs text-[var(--positive)]">{savedNote}</span>}
          {done && <span className="text-xs text-[var(--positive)]">{done}</span>}
          {selectedTpl.stored && <button onClick={remove} className="btn h-8 py-0 text-xs text-[var(--danger)]">Delete</button>}
          <button onClick={save} disabled={saving} className="btn h-8 py-0 text-xs">{saving ? "Saving…" : selectedTpl.stored ? "Save" : "Save as new"}</button>
          <button onClick={generate} disabled={busy} className="btn-brand h-8 py-0 text-xs">{busy ? "…" : "Download .pptx"}</button>
        </div>
      </div>

      {error && <div className="border-b border-[var(--border)] border-l-2 border-l-[var(--danger)] bg-[var(--panel)] px-4 py-2 text-sm text-[var(--danger)]">{error}</div>}

      <div className="flex flex-1 overflow-hidden">
        {/* Slide thumbnails */}
        <div className="flex w-48 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel-2)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Slides</span>
            <span className="rounded-full bg-[var(--panel-inset)] px-1.5 py-0.5 text-[0.65rem] tabular-nums text-[var(--muted)]">{slides.length}</span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {resolvedSlides.map((_, i) => (
              <button key={i} onClick={() => { setSlideIdx(i); setSel(null); }}
                className={`flex w-full items-start gap-2 rounded-md border p-1 text-left transition-colors ${i === curSlide ? "border-[var(--brand-ink)] ring-1 ring-[var(--brand-ink)]" : "border-[var(--border)] hover:border-[var(--border-strong)]"}`}>
                <span className={`mt-0.5 w-3 shrink-0 text-center text-[0.6rem] tabular-nums ${i === curSlide ? "text-[var(--brand-ink)]" : "text-[var(--muted)]"}`}>{i + 1}</span>
                <span className="pointer-events-none min-w-0 flex-1"><SlideView template={resolved} index={i} /></span>
              </button>
            ))}
          </div>
          <div className="space-y-1.5 border-t border-[var(--border)] p-2">
            <button onClick={addSlide} className="btn-brand w-full py-1.5 text-xs" title="Add a blank slide">
              <PlusIcon /> Add slide
            </button>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={duplicateSlide} className="btn py-1.5 text-xs" title="Duplicate this slide">
                <CopyIcon /> Duplicate
              </button>
              <button onClick={deleteSlide} disabled={slides.length <= 1} className="btn py-1.5 text-xs text-[var(--danger)]" title="Delete this slide">
                <TrashIcon /> Delete
              </button>
            </div>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex flex-1 items-start justify-center overflow-auto bg-[var(--bg)] p-6" onClick={() => setSel(null)}>
          <div className="w-full max-w-[64rem]" onClick={(e) => e.stopPropagation()}>
            <SlideView template={resolved} index={curSlide} selected={sel} onSelect={(s, e) => setSel(e < 0 ? null : { s, e })} />
            <div className="mt-2 text-center text-xs text-[var(--muted)]">Slide {curSlide + 1} of {slides.length} · click an element to edit, or insert one from the right</div>
          </div>
        </div>

        {/* Properties */}
        <div className="w-80 shrink-0 space-y-4 overflow-y-auto border-l border-[var(--border)] bg-[var(--panel-2)] p-4">
          {/* Insert */}
          <div>
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">Insert</div>
            <div className="grid grid-cols-2 gap-2">
              {(["text", "kpi", "bullets", "chart", "table", "divider"] as const).map((t) => (
                <button key={t} onClick={() => addElement(t)} className="btn py-1.5 text-xs capitalize">+ {t}</button>
              ))}
            </div>
          </div>

          {/* Contextual design */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-medium">{selEl ? `Edit ${str(selEl.type)}` : "Deck theme"}</span>
              {selEl && <button onClick={deleteElement} className="text-xs text-[var(--danger)] hover:underline">Delete</button>}
            </div>
            {!selEl ? (
              <ThemePanel theme={(editable.theme as Any) ?? {}} onChange={patchTheme} />
            ) : str(selEl.type) === "text" ? (
              <TextPanel el={selEl} onChange={patchSel} />
            ) : str(selEl.type) === "kpi" ? (
              <KpiPanel el={selEl} onChange={patchSel} />
            ) : str(selEl.type) === "shape" ? (
              <ShapePanel el={selEl} onChange={patchSel} />
            ) : str(selEl.type) === "chart" ? (
              <ChartPanel el={selEl} onChange={patchSel} />
            ) : (
              <p className="text-xs text-[var(--muted)]">Editing controls for {str(selEl.type)} are coming; position &amp; size below work now.</p>
            )}
            {selEl && <PosSize el={selEl} onChange={patchSel} />}
          </div>

          {/* Fill with AI */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="text-sm font-medium">Fill with AI</div>
            <p className="mt-1 text-xs text-[var(--muted)]">An agent reads the fields and writes the values from the data servers.</p>
            <input value={aiContext} onChange={(e) => setAiContext(e.target.value)} placeholder="e.g. “Acme, this week”" className="field mt-2 text-sm" />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-[var(--positive)]">{aiNote}</span>
              <button onClick={fillWithAi} disabled={aiBusy} className="btn-brand text-xs">{aiBusy ? "Filling…" : "Fill with AI"}</button>
            </div>
          </div>

          {/* Data (manual) */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <button onClick={() => setShowData((v) => !v)} className="flex w-full items-center justify-between text-sm font-medium">
              <span>Data ({selectedTpl.fields.length} fields)</span><span className="text-[var(--muted)]">{showData ? "–" : "+"}</span>
            </button>
            {showData && (
              <textarea value={valuesText} onChange={(e) => setValues(e.target.value)} rows={12} spellCheck={false} className="field mono mt-2 resize-y text-xs leading-relaxed" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2.5 flex items-center justify-between gap-3">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <span className="flex items-center gap-1.5">{children}</span>
    </label>
  );
}

function PosSize({ el, onChange }: { el: Any; onChange: (p: Any) => void }) {
  const f = (k: string) => (
    <input key={k} type="number" step={0.1} value={num(el[k])} onChange={(e) => onChange({ [k]: Number(e.target.value) })} className="field w-16 text-xs" />
  );
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">Position &amp; size (in)</div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--muted)]">x</span>{f("x")}
        <span className="text-xs text-[var(--muted)]">y</span>{f("y")}
        <span className="text-xs text-[var(--muted)]">w</span>{f("w")}
        <span className="text-xs text-[var(--muted)]">h</span>{f("h")}
      </div>
    </div>
  );
}

function TextPanel({ el, onChange }: { el: Any; onChange: (p: Any) => void }) {
  const align = str(el.align, "left");
  return (
    <div>
      <label className="mb-2.5 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Text</span>
        <input value={str(el.text)} onChange={(e) => onChange({ text: e.target.value })} className="field text-sm" />
      </label>
      <Row label="Font size"><input type="number" min={6} max={96} value={num(el.fontSize, 16)} onChange={(e) => onChange({ fontSize: Number(e.target.value) })} className="field w-16 text-xs" /></Row>
      <Row label="Color"><input type="color" value={toHex(el.color)} onChange={(e) => onChange({ color: e.target.value })} className="h-7 w-9 rounded border border-[var(--border)] bg-transparent" /></Row>
      <Row label="Style">
        <button onClick={() => onChange({ bold: !el.bold })} className={`rounded border px-2 py-1 text-xs ${el.bold ? "border-[var(--brand-ink)] text-[var(--brand-ink)]" : "border-[var(--border)] text-[var(--muted)]"}`}>B</button>
        <button onClick={() => onChange({ italic: !el.italic })} className={`rounded border px-2 py-1 text-xs italic ${el.italic ? "border-[var(--brand-ink)] text-[var(--brand-ink)]" : "border-[var(--border)] text-[var(--muted)]"}`}>I</button>
      </Row>
      <Row label="Align">
        {(["left", "center", "right"] as const).map((a) => (
          <button key={a} onClick={() => onChange({ align: a })} className={`rounded border px-2 py-1 text-xs capitalize ${align === a ? "border-[var(--brand-ink)] text-[var(--brand-ink)]" : "border-[var(--border)] text-[var(--muted)]"}`}>{a[0]}</button>
        ))}
      </Row>
    </div>
  );
}

function ChartPanel({ el, onChange }: { el: Any; onChange: (p: Any) => void }) {
  const type = str(el.chartType, "bar");
  const colors = Array.isArray(el.colors) ? (el.colors as string[]) : [];
  return (
    <div>
      <Row label="Type">
        <select value={type} onChange={(e) => onChange({ chartType: e.target.value })} className="field w-24 text-xs">
          <option value="bar">Bar</option><option value="line">Line</option><option value="area">Area</option><option value="pie">Pie</option>
        </select>
      </Row>
      <label className="mb-2.5 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Title</span>
        <input value={str(el.title)} onChange={(e) => onChange({ title: e.target.value })} className="field text-sm" />
      </label>
      <Row label="Primary color"><input type="color" value={toHex(colors[0] ?? "#10B981")} onChange={(e) => onChange({ colors: [e.target.value, ...colors.slice(1)] })} className="h-7 w-9 rounded border border-[var(--border)] bg-transparent" /></Row>
      <Row label="Legend">
        <button onClick={() => onChange({ showLegend: el.showLegend === false })} className={`rounded border px-2 py-1 text-xs ${el.showLegend === false ? "border-[var(--border)] text-[var(--muted)]" : "border-[var(--brand-ink)] text-[var(--brand-ink)]"}`}>{el.showLegend === false ? "Off" : "On"}</button>
      </Row>
    </div>
  );
}

function KpiPanel({ el, onChange }: { el: Any; onChange: (p: Any) => void }) {
  return (
    <div>
      <label className="mb-2.5 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Label</span>
        <input value={str(el.label)} onChange={(e) => onChange({ label: e.target.value })} className="field text-sm" placeholder="Week return" />
      </label>
      <label className="mb-2.5 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Value</span>
        <input value={str(el.value)} onChange={(e) => onChange({ value: e.target.value })} className="field text-sm" placeholder="+1.9% or {{week_return}}" />
      </label>
      <label className="mb-2.5 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Caption</span>
        <input value={str(el.caption)} onChange={(e) => onChange({ caption: e.target.value })} className="field text-sm" placeholder="vs. prior week" />
      </label>
      <Row label="Value size"><input type="number" min={12} max={96} value={num(el.valueSize, 40)} onChange={(e) => onChange({ valueSize: Number(e.target.value) })} className="field w-16 text-xs" /></Row>
      <Row label="Color"><input type="color" value={toHex(el.color ?? ACCENT)} onChange={(e) => onChange({ color: e.target.value })} className="h-7 w-9 rounded border border-[var(--border)] bg-transparent" /></Row>
      <Row label="Align">
        {(["left", "center", "right"] as const).map((a) => (
          <button key={a} onClick={() => onChange({ align: a })} className={`rounded border px-2 py-1 text-xs capitalize ${str(el.align, "left") === a ? "border-[var(--brand-ink)] text-[var(--brand-ink)]" : "border-[var(--border)] text-[var(--muted)]"}`}>{a[0]}</button>
        ))}
      </Row>
    </div>
  );
}

function ShapePanel({ el, onChange }: { el: Any; onChange: (p: Any) => void }) {
  const isLine = str(el.shape, "rect") === "line";
  return (
    <div>
      <Row label="Shape">
        {(["rect", "line"] as const).map((s) => (
          <button key={s} onClick={() => onChange({ shape: s })} className={`rounded border px-2 py-1 text-xs capitalize ${str(el.shape, "rect") === s ? "border-[var(--brand-ink)] text-[var(--brand-ink)]" : "border-[var(--border)] text-[var(--muted)]"}`}>{s}</button>
        ))}
      </Row>
      {isLine ? (
        <>
          <Row label="Line color"><input type="color" value={toHex(el.line ?? HAIRLINE)} onChange={(e) => onChange({ line: e.target.value })} className="h-7 w-9 rounded border border-[var(--border)] bg-transparent" /></Row>
          <Row label="Thickness"><input type="number" min={0.5} max={12} step={0.5} value={num(el.lineWidth, 1)} onChange={(e) => onChange({ lineWidth: Number(e.target.value) })} className="field w-16 text-xs" /></Row>
        </>
      ) : (
        <>
          <Row label="Fill"><input type="color" value={toHex(el.fill ?? ACCENT)} onChange={(e) => onChange({ fill: e.target.value })} className="h-7 w-9 rounded border border-[var(--border)] bg-transparent" /></Row>
          <Row label="Corner radius"><input type="number" min={0} max={1} step={0.02} value={num(el.radius, 0)} onChange={(e) => onChange({ radius: Number(e.target.value) })} className="field w-16 text-xs" /></Row>
        </>
      )}
    </div>
  );
}

function ThemePanel({ theme, onChange }: { theme: Any; onChange: (p: Any) => void }) {
  return (
    <div>
      <p className="mb-2.5 text-xs text-[var(--muted)]">Nothing selected — editing the deck theme.</p>
      <Row label="Background"><input type="color" value={toHex(theme.bg ?? "#FFFFFF")} onChange={(e) => onChange({ bg: e.target.value })} className="h-7 w-9 rounded border border-[var(--border)] bg-transparent" /></Row>
      <Row label="Ink (text)"><input type="color" value={toHex(theme.ink ?? INK)} onChange={(e) => onChange({ ink: e.target.value })} className="h-7 w-9 rounded border border-[var(--border)] bg-transparent" /></Row>
      <Row label="Accent"><input type="color" value={toHex(theme.accent ?? ACCENT)} onChange={(e) => onChange({ accent: e.target.value })} className="h-7 w-9 rounded border border-[var(--border)] bg-transparent" /></Row>
    </div>
  );
}

// --- inline icons ---
const iconProps = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
function PlusIcon() { return <svg {...iconProps}><path d="M12 5v14M5 12h14" /></svg>; }
function CopyIcon() { return <svg {...iconProps}><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M6 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v1" /></svg>; }
function TrashIcon() { return <svg {...iconProps}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" /></svg>; }
