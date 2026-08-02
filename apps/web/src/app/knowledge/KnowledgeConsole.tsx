"use client";

import { useState } from "react";
import {
  addDocumentAction,
  deleteDocumentAction,
  testRetrievalAction,
  syncSourceAction,
} from "./actions";
import type {
  DocRow,
  KnowledgeSnapshot,
  RetrievedRow,
  SourceRow,
} from "./types";

const H2 = "text-xs font-medium uppercase tracking-wide text-[var(--muted)]";

export function KnowledgeConsole({
  initial,
  sources,
  embedder,
}: {
  initial: KnowledgeSnapshot;
  sources: SourceRow[];
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
    <div className="space-y-8">
      {embedder && !embedder.production && (
        <div className="panel border-l-2 border-l-[var(--warning)] p-4 text-sm text-[var(--warning)]">
          Embedder is <code>{embedder.name}</code> — a dev fallback. Its vectors
          aren&apos;t compatible with Voyage, so set <code>VOYAGE_API_KEY</code> and
          re-ingest before relying on retrieval quality.
        </div>
      )}

      {error && (
        <div className="panel border-l-2 border-l-[var(--danger)] p-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {sources.length > 0 && <Sources sources={sources} onSynced={apply} />}

      <AddDocument collections={snap.collections} onDone={apply} />

      <TestRetrieval />

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5">
          <h2 className={H2}>Indexed documents</h2>
          <span className="text-xs text-[var(--muted)]">
            {snap.documents.length} docs ·{" "}
            {snap.documents.reduce((a, d) => a + d.chunkCount, 0)} chunks
            {embedder && ` · ${embedder.name}`}
          </span>
        </div>

        {snap.documents.length === 0 ? (
          <p className="hairline px-5 py-8 text-center text-sm text-[var(--muted)]">
            Nothing indexed yet. Add a document above and it becomes retrievable context.
          </p>
        ) : (
          <ul>
            {snap.documents.map((d) => (
              <DocumentRow key={d.id} doc={d} onDone={apply} />
            ))}
          </ul>
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
    <section className="panel p-5">
      <h2 className={`${H2} mb-4`}>Add a document</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title" value={title} onChange={setTitle} placeholder="Refund policy" />
        <Field label="Source" value={source} onChange={setSource} placeholder="handbook" />
        <label className="block">
          <div className="mb-1 text-xs text-[var(--muted)]">Collection (optional)</div>
          <input
            list="collections"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="e.g. ops-handbook"
            className="field"
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
        className="field mt-3 resize-y"
      />
      <div className="mt-3 flex justify-end">
        <button onClick={add} disabled={busy || !content.trim()} className="btn-brand">
          {busy ? "Indexing…" : "Index document"}
        </button>
      </div>
    </section>
  );
}

function Sources({
  sources,
  onSynced,
}: {
  sources: SourceRow[];
  onSynced: (out: KnowledgeSnapshot | { error: string }) => void;
}) {
  const [collection, setCollection] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sync(type: string) {
    setBusy(type);
    setNote(null);
    setError(null);
    const out = await syncSourceAction(type, collection);
    if ("error" in out) setError(out.error);
    else {
      setNote(`Synced ${out.synced} document${out.synced === 1 ? "" : "s"} (${out.chunks} chunks).`);
      onSynced(out.snapshot);
    }
    setBusy(null);
  }

  return (
    <section className="panel p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className={H2}>Connected sources</h2>
        <input
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          placeholder="sync into collection (optional)"
          className="field max-w-[16rem] text-xs"
        />
      </div>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Connectors that pull documents in on demand. Re-syncing replaces a source&apos;s
        docs, so it never duplicates.
      </p>

      <div className="space-y-2">
        {sources.map((s) => (
          <div key={s.type} className="inset flex items-center justify-between gap-4 p-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-[var(--text)]">{s.label}</h3>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                    s.configured
                      ? "bg-[var(--brand-soft)] text-[var(--positive)]"
                      : "border border-[var(--border)] text-[var(--muted)]"
                  }`}
                >
                  {s.configured ? "Connected" : "Not configured"}
                </span>
              </div>
              <div className="mono mt-1 text-xs text-[var(--muted)]">
                source type {s.type}
              </div>
            </div>
            <button
              onClick={() => sync(s.type)}
              disabled={busy !== null || !s.configured}
              title={s.configured ? "" : "Set this connector's credentials to enable sync"}
              className="btn shrink-0"
            >
              {busy === s.type ? "Syncing…" : "Sync"}
            </button>
          </div>
        ))}
      </div>

      {note && <div className="mt-3 text-sm text-[var(--positive)]">{note}</div>}
      {error && <div className="mt-3 text-sm text-[var(--danger)]">{error}</div>}
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
    <li className="hairline flex items-start justify-between gap-4 px-5 py-3.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-[var(--text)]">{doc.title || "(untitled)"}</h3>
          {doc.collection && (
            <span className="rounded bg-[var(--brand-soft)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--brand-ink)]">
              {doc.collection}
            </span>
          )}
        </div>
        <div className="mono mt-1 text-xs text-[var(--muted)]">
          {doc.chunkCount} chunk{doc.chunkCount === 1 ? "" : "s"} · {doc.sourceType}
          {doc.source && ` · ${doc.source}`} ·{" "}
          {new Date(doc.createdAt).toLocaleDateString()}
        </div>
      </div>
      <button
        onClick={del}
        disabled={busy}
        className="shrink-0 text-xs text-[var(--muted)] transition hover:text-[var(--danger)] disabled:opacity-40"
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
    </li>
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
    <section className="panel p-5">
      <h2 className={`${H2} mb-1`}>Test retrieval</h2>
      <p className="mb-4 text-sm text-[var(--muted)]">
        See exactly which chunks a query would pull, and how strongly — the same
        ranking a RAG-enabled Skill run uses.
      </p>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query.trim() && run()}
          placeholder="e.g. What is our refund window?"
          className="field flex-1"
        />
        <button onClick={run} disabled={busy || !query.trim()} className="btn">
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      {error && <div className="mt-3 text-sm text-[var(--danger)]">{error}</div>}

      {chunks && (
        <div className="mt-4 space-y-2">
          {chunks.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No chunks matched.</p>
          ) : (
            chunks.map((c) => (
              <div key={`${c.documentId}-${c.chunkIndex}`} className="inset p-3">
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                  <span className="truncate text-[var(--text-soft)]">
                    {c.title || "(untitled)"}{" "}
                    <span className="text-[var(--muted)]">#{c.chunkIndex}</span>
                  </span>
                  <span className="mono shrink-0 text-[var(--brand-ink)]">
                    {(c.score * 100).toFixed(0)}% match
                  </span>
                </div>
                <p className="mt-2 text-sm text-[var(--text-soft)]">{c.preview}…</p>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function Field({
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
      <div className="mb-1 text-xs text-[var(--muted)]">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="field"
      />
    </label>
  );
}
