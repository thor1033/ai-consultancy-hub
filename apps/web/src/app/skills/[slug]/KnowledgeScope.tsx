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
    <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        Knowledge scope
      </div>
      <p className="mt-1 text-sm text-neutral-400">
        When RAG is on, this skill retrieves from{" "}
        {saved ? (
          <>
            the <span className="text-emerald-400">{saved}</span> collection.
          </>
        ) : (
          <>the whole knowledge base.</>
        )}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
        >
          <option value="">Whole knowledge base</option>
          {collections.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition hover:border-emerald-500/50 hover:text-emerald-400 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      {error && <div className="mt-2 text-sm text-red-300">{error}</div>}
    </div>
  );
}
