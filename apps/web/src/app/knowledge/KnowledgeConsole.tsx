"use client";

import { useState } from "react";
import {
  addDocumentAction,
  deleteDocumentAction,
  testRetrievalAction,
} from "./actions";
import type { DocRow, KnowledgeSnapshot, RetrievedRow } from "./types";

export function KnowledgeConsole({
  initial,
  embedder,
}: {
  initial: KnowledgeSnapshot;
  embedder: { name: string; production: boolean } | null;
}) {
  const [snap, setSnap] = useState<KnowledgeSnapshot>(initial);
  const [error, setError] = useState<string | null>(null);

  function apply(out: KnowledgeSnapshot | { error: string }) {
    if ("error" in out) setError(out.error);
    else {
      setError(null);
      setSnap(out);
    }
  }

  return (
    <div className="space-y-12">
      {embedder && !embedder.production && (
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-300">
          Embedder is <code>{embedder.name}</code> — a dev fallback. Its vectors
          aren&apos;t compatible with Voyage, so set <code>VOYAGE_API_KEY</code> and
          re-ingest before relying on retrieval quality.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <AddDocument collections={snap.collections} onDone={apply} />

      <TestRetrieval />

      {/* Overview */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
            Indexed documents
          </h2>
          <span className="text-xs text-neutral-600">
            {snap.documents.length} docs ·{" "}
            {snap.documents.reduce((a, d) => a + d.chunkCount, 0)} chunks
            {embedder && ` · ${embedder.name}`}
          </span>
        </div>

        {snap.documents.length === 0 ? (
          <p className="text-neutral-500">
            Nothing indexed yet. Add a document above and it becomes retrievable context.
          </p>
        ) : (
          <div className="space-y-2">
            {snap.documents.map((d) => (
              <DocumentRow key={d.id} doc={d} onDone={apply} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function AddDocument({
  collections,
  onDone,
}: {
  collections: string[];
  onDone: (out: KnowledgeSnapshot | { error: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [collection, setCollection] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    const out = await addDocumentAction({ title, source, collection, content });
    if (!("error" in out)) {
      setTitle("");
      setSource("");
      setContent("");
    }
    onDone(out);
    setBusy(false);
  }

  return (
    <section>
      <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Add a document
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Title" value={title} onChange={setTitle} placeholder="Refund policy" />
        <Input label="Source" value={source} onChange={setSource} placeholder="handbook" />
        <label className="block">
          <div className="mb-1 text-xs text-neutral-500">Collection (optional)</div>
          <input
            list="collections"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="e.g. ops-handbook"
            className="input"
          />
          <datalist id="collections">
            {collections.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={6}
        placeholder="Paste the document text to index…"
        className="input mt-3 resize-y"
      />
      <div className="mt-3 flex justify-end">
        <button
          onClick={add}
          disabled={busy || !content.trim()}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-40"
        >
          {busy ? "Indexing…" : "Index document"}
        </button>
      </div>
      <style>{inputCss}</style>
    </section>
  );
}

function DocumentRow({
  doc,
  onDone,
}: {
  doc: DocRow;
  onDone: (out: KnowledgeSnapshot | { error: string }) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function del() {
    if (!confirm(`Delete "${doc.title || "(untitled)"}" and its chunks?`)) return;
    setBusy(true);
    onDone(await deleteDocumentAction(doc.id));
    setBusy(false);
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-neutral-100">{doc.title || "(untitled)"}</h3>
          {doc.collection && (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
              {doc.collection}
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-neutral-500">
          {doc.chunkCount} chunk{doc.chunkCount === 1 ? "" : "s"} · {doc.sourceType}
          {doc.source && ` · ${doc.source}`} ·{" "}
          {new Date(doc.createdAt).toLocaleDateString()}
        </div>
      </div>
      <button
        onClick={del}
        disabled={busy}
        className="shrink-0 text-xs text-neutral-500 hover:text-red-400 disabled:opacity-40"
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
}

function TestRetrieval() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [chunks, setChunks] = useState<RetrievedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const out = await testRetrievalAction(query);
    if ("error" in out) {
      setError(out.error);
      setChunks(null);
    } else {
      setChunks(out.chunks);
    }
    setBusy(false);
  }

  return (
    <section>
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Test retrieval
      </h2>
      <p className="mb-4 text-sm text-neutral-500">
        See exactly which chunks a query would pull, and how strongly — the same
        ranking a RAG-enabled Skill run uses.
      </p>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query.trim() && run()}
          placeholder="e.g. What is our refund window?"
          className="input flex-1"
        />
        <button
          onClick={run}
          disabled={busy || !query.trim()}
          className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition hover:border-emerald-500/50 hover:text-emerald-400 disabled:opacity-40"
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      {error && <div className="mt-3 text-sm text-red-300">{error}</div>}

      {chunks && (
        <div className="mt-4 space-y-2">
          {chunks.length === 0 ? (
            <p className="text-sm text-neutral-500">No chunks matched.</p>
          ) : (
            chunks.map((c) => (
              <div
                key={`${c.documentId}-${c.chunkIndex}`}
                className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3"
              >
                <div className="flex items-center justify-between gap-3 text-xs text-neutral-500">
                  <span className="truncate text-neutral-300">
                    {c.title || "(untitled)"}{" "}
                    <span className="text-neutral-600">#{c.chunkIndex}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {(c.score * 100).toFixed(0)}% match
                  </span>
                </div>
                <p className="mt-2 text-sm text-neutral-400">{c.preview}…</p>
              </div>
            ))
          )}
        </div>
      )}
      <style>{inputCss}</style>
    </section>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-neutral-500">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input"
      />
    </label>
  );
}

const inputCss = `
  .input {
    width: 100%;
    border-radius: 0.5rem;
    border: 1px solid rgb(38 38 38);
    background: rgb(23 23 23 / 0.6);
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    color: rgb(245 245 245);
    outline: none;
  }
  .input:focus { border-color: rgb(82 82 82); }
`;
