"use client";

import { useState } from "react";
import { setSkillCollectionAction } from "./actions";

// Curation control (docs/knowledge-rag.md, Phase 2): pick which knowledge
// collection this skill retrieves from when RAG is on. Blank = the whole index.
export function KnowledgeScope({
  slug,
  collection,
  collections,
}: {
  slug: string;
  collection: string | null;
  collections: string[];
}) {
  const [value, setValue] = useState(collection ?? "");
  const [saved, setSaved] = useState(collection ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = value !== saved;

  async function save() {
    setBusy(true);
    setError(null);
    const out = await setSkillCollectionAction(slug, value);
    if ("error" in out) setError(out.error ?? "Save failed.");
    else setSaved(out.collection ?? "");
    setBusy(false);
  }

  return (
    <div className="panel mt-6 p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
        Knowledge scope
      </div>
      <p className="mt-1 text-sm text-[var(--muted)]">
        When RAG is on, this skill retrieves from{" "}
        {saved ? (
          <>
            the <span className="text-[var(--brand-ink)]">{saved}</span> collection.
          </>
        ) : (
          <>the whole knowledge base.</>
        )}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="field max-w-[16rem]"
        >
          <option value="">Whole knowledge base</option>
          {collections.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button onClick={save} disabled={busy || !dirty} className="btn">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      {error && <div className="mt-2 text-sm text-[var(--danger)]">{error}</div>}
    </div>
  );
}
