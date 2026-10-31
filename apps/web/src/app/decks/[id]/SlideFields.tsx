"use client";

import { useState } from "react";

// A slide's content as plain fields, for people who should not have to write
// JSON (docs/views.md). Generic on purpose: whatever a slide kind holds, its
// text is a field, a list of text is one line per item, a number is a number.
// Anything deeper — a table's rows, a chart's series — keeps a small JSON box
// of its own, so nothing a slide holds is out of reach. What is saved is the
// same JSON the expert editor saves, so the server's checks are the same.

type Value = unknown;

const isTextList = (v: Value): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const label = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

export function SlideFields({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: Record<string, Value>;
  busy: boolean;
  onSave: (json: string) => void;
  onCancel: () => void;
}) {
  const kind = String(initial.kind ?? "");
  const keys = Object.keys(initial).filter((k) => k !== "kind");
  // Each field's editable text, kept as typed so a half-written list is not reformatted under the cursor.
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      keys.map((k) => {
        const v = initial[k];
        if (typeof v === "string") return [k, v];
        if (typeof v === "number" || typeof v === "boolean") return [k, String(v)];
        if (isTextList(v)) return [k, v.join("\n")];
        return [k, JSON.stringify(v, null, 2)];
      }),
    ),
  );
  const [error, setError] = useState<string | null>(null);

  function save() {
    const out: Record<string, Value> = { kind };
    for (const k of keys) {
      const was = initial[k];
      const t = text[k] ?? "";
      if (typeof was === "string") out[k] = t;
      else if (typeof was === "number") {
        const n = Number(t);
        if (!Number.isFinite(n)) return setError(`${label(k)} must be a number.`);
        out[k] = n;
      } else if (typeof was === "boolean") out[k] = t === "true";
      else if (isTextList(was)) out[k] = t.split("\n").map((x) => x.trim()).filter(Boolean);
      else {
        try {
          out[k] = JSON.parse(t);
        } catch {
          return setError(`${label(k)} is not valid. Undo your change to it, or ask an expert.`);
        }
      }
    }
    setError(null);
    onSave(JSON.stringify(out));
  }

  return (
    <div className="mt-2 flex flex-col gap-3">
      {keys.map((k) => {
        const was = initial[k];
        const long = typeof was === "string" && (was.length > 80 || /notes|body|text|quote|caption/i.test(k));
        return (
          <label key={k} className="block">
            <span className="mb-1 block text-xs text-[var(--muted)]">
              {label(k)}
              {isTextList(was) && " — one per line"}
            </span>
            {typeof was === "boolean" ? (
              <select className="field" value={text[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })}>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : typeof was === "number" ? (
              <input className="field" type="number" value={text[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })} />
            ) : typeof was === "string" && !long ? (
              <input className="field" value={text[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })} />
            ) : (
              <textarea
                className={`field min-h-24 ${typeof was === "string" || isTextList(was) ? "" : "mono text-xs"}`}
                value={text[k]}
                onChange={(e) => setText({ ...text, [k]: e.target.value })}
                spellCheck={typeof was === "string" || isTextList(was)}
              />
            )}
          </label>
        );
      })}
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn-brand min-h-9 text-xs" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save slide"}
        </button>
        <button type="button" className="btn min-h-9 text-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
