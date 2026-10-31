"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDocumentAction,
  deleteDocumentAction,
  getDocumentAction,
  testRetrievalAction,
  syncSourceAction,
} from "./actions";
import type { DocRow, DocDetail, KnowledgeContext, KnowledgeSnapshot, RetrievedRow, SourceRow } from "./types";
import { rel } from "@/lib/format";

// What each connector needs before it can sync, in the deployer's words.
const SOURCE_SETUP: Record<string, { what: string; env: string[] }> = {
  confluence: {
    what: "Pulls every page from your Confluence space.",
    env: ["CONFLUENCE_BASE_URL", "CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN"],
  },
  "pm-tool": {
    what: "Pulls each project's documents — business case, scope, plans, KPIs — from the PM-tool.",
    env: ["HUB_REMOTE_MCP_SERVERS (with a pm-tool entry)", "PM_TOOL_MCP_TOKEN"],
  },
  // One source per folder in HUB_SHAREPOINT_FOLDERS, typed sharepoint:<key>.
  sharepoint: {
    what: "Keeps one of the team's shared folders indexed, each folder in its own collection. Files added, changed or deleted there show up here within the hour.",
    env: ["HUB_SHAREPOINT_FOLDERS", "M365_TEAMS_SITE_URL"],
  },
  // One source per repository in HUB_GITHUB_SOURCES, typed github:<key>.
  github: {
    what: "Pulls a repository's docs — docs/, README, CLAUDE.md — at one commit, so an agent knows the product's design record.",
    env: ["GITHUB_TOKEN"],
  },
};

const setupFor = (type: string) => SOURCE_SETUP[type] ?? SOURCE_SETUP[type.split(":")[0]];

const UNFILED = "__unfiled__";
const ALL = "__all__";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The short state of a source for the side panel. A source on the clock says
 * when it last synced — and, louder, when that failed — because nobody presses
 * "Sync now" on it, so this is the only place its breaking would show.
 */
function sourceState(s: SourceRow, now: number): { text: string; tone: "ok" | "off" | "bad" } {
  if (!s.configured) return { text: "Not connected", tone: "off" };
  const last = s.lastSync;
  if (!s.autoSyncMinutes || !last) return { text: s.autoSyncMinutes ? "Waiting for first sync" : "Connected", tone: "ok" };
  if (last.running && !last.at) return { text: "First sync running", tone: "ok" };
  if (last.ok === false) return { text: `Sync failed ${rel(last.at, now).toLowerCase()}`, tone: "bad" };
  return { text: `Synced ${rel(last.at, now).toLowerCase()}`, tone: "ok" };
}

const TONE = { ok: "var(--ai)", off: "var(--faint)", bad: "var(--danger)" } as const;

type Result = KnowledgeSnapshot | { error: string };

export function KnowledgeConsole({
  initial,
  context,
  sources,
  embedder,
  canWrite,
}: {
  initial: KnowledgeSnapshot;
  context: KnowledgeContext;
  sources: SourceRow[];
  embedder: { name: string; production: boolean } | null;
  canWrite: boolean;
}) {
  const [snap, setSnap] = useState<KnowledgeSnapshot>(initial);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"add" | "sources" | null>(null);
  const [scope, setScope] = useState<string>(ALL);
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  function apply(out: Result) {
    if ("error" in out) setError(out.error);
    else {
      setError(null);
      setSnap(out);
    }
  }

  const docs = snap.documents;
  const passages = docs.reduce((a, d) => a + d.chunkCount, 0);
  const unfiled = docs.filter((d) => !d.collection).length;
  const restricted = new Set(context.restricted);
  const usedBy = (c: string) => context.scopes.filter((s) => s.collection === c).map((s) => s.name);
  const access = (c: string | null) =>
    c === null
      ? context.defaultVisibility === "restricted"
        ? "Nobody"
        : "Everyone"
      : restricted.has(c)
        ? "Restricted"
        : "Everyone";

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return docs.filter((d) => {
      if (scope === UNFILED && d.collection) return false;
      if (scope !== ALL && scope !== UNFILED && d.collection !== scope) return false;
      if (!q) return true;
      return [d.title, d.source ?? "", d.collection ?? "", d.preview ?? ""].some((v) => v.toLowerCase().includes(q));
    });
  }, [docs, scope, filter]);

  const scopeTitle = scope === ALL ? "All documents" : scope === UNFILED ? "Unfiled" : scope;
  const connected = sources.filter((s) => s.configured);

  function openDocument(id: string) {
    setScope(ALL);
    setFilter("");
    setOpenId(id);
    requestAnimationFrame(() => document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow">Knowledge</div>
          <h1 className="mt-3 text-3xl md:text-4xl">What the agents can look up.</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
            Documents the agents retrieve from when they answer. Everything here is searchable by meaning, and each
            collection decides who — and which agent — can read it.
          </p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn min-h-11"
              aria-expanded={panel === "sources"}
              onClick={() => setPanel(panel === "sources" ? null : "sources")}
            >
              Connect a source
            </button>
            <button
              type="button"
              className="btn-brand min-h-11"
              aria-expanded={panel === "add"}
              onClick={() => setPanel(panel === "add" ? null : "add")}
            >
              Add document
            </button>
          </div>
        )}
      </header>

      {error && (
        <div role="alert" className="panel notice-danger flex items-start justify-between gap-3 p-3 text-sm text-[var(--danger)]">
          <span>{error}</span>
          <button type="button" className="text-xs underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {panel === "add" && (
        <AddDocument
          collections={snap.collections}
          defaultCollection={scope !== ALL && scope !== UNFILED ? scope : ""}
          onCancel={() => setPanel(null)}
          onDone={(out) => {
            apply(out);
            if (!("error" in out)) setPanel(null);
          }}
        />
      )}
      {panel === "sources" && <Sources sources={sources} onSynced={apply} onClose={() => setPanel(null)} />}

      <div className="rule-heavy grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat value={docs.length} label="Documents" node={docs.length ? undefined : "var(--brand)"} />
        <Stat value={snap.collections.length} label="Collections" />
        <Stat value={passages} label="Searchable passages" />
        <Stat value={new Set(context.scopes.map((s) => s.slug)).size} label="Agents using it" node="var(--ai)" />
        <Stat
          value={embedder ? (embedder.production ? "Voyage" : "Fallback") : "—"}
          label="Search engine"
          node={embedder?.production ? "var(--ai)" : "var(--brand)"}
        />
      </div>

      {embedder && !embedder.production && (
        <div className="panel notice-warning flex flex-wrap items-baseline gap-x-2 p-3 text-sm">
          <span className="font-bold text-[var(--warning)]">Search is approximate.</span>
          <span className="text-[var(--text-soft)]">
            It is running on the <code>{embedder.name}</code> fallback, which matches words rather than meaning. Set{" "}
            <code>VOYAGE_API_KEY</code>, then re-add or re-sync the documents.
          </span>
        </div>
      )}

      {docs.length === 0 ? (
        <EmptyState
          canWrite={canWrite}
          connected={connected}
          onAdd={() => setPanel("add")}
          onConnect={() => setPanel("sources")}
        />
      ) : (
        <>
          <Ask onOpen={openDocument} />

          <div className="flex flex-wrap items-start gap-6">
            <aside aria-label="Collections" className="flex min-w-0 flex-[1_1_260px] flex-col gap-6">
              <nav className="panel">
                <div className="eyebrow px-4 pb-2 pt-4">Collections</div>
                <ScopeButton
                  active={scope === ALL}
                  onClick={() => setScope(ALL)}
                  title="All documents"
                  count={docs.length}
                />
                {snap.collections.map((c) => {
                  const users = usedBy(c);
                  return (
                    <ScopeButton
                      key={c}
                      active={scope === c}
                      onClick={() => setScope(c)}
                      title={c}
                      count={docs.filter((d) => d.collection === c).length}
                      mono
                      meta={[access(c), users.length ? `Used by ${users.join(", ")}` : null]}
                      restricted={restricted.has(c)}
                    />
                  );
                })}
                {unfiled > 0 && (
                  <ScopeButton
                    active={scope === UNFILED}
                    onClick={() => setScope(UNFILED)}
                    title="Unfiled"
                    count={unfiled}
                    meta={[`${access(null)} · no agent is scoped to it`]}
                  />
                )}
              </nav>
              <SourceSummary sources={sources} canWrite={canWrite} onOpen={() => setPanel("sources")} />
            </aside>

            <section aria-labelledby="docs-title" className="panel min-w-0 flex-[999_1_560px]">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-4">
                <div className="min-w-0">
                  <h2 id="docs-title" className="text-xl">
                    {scopeTitle}
                  </h2>
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    {plural(shown.length, "document")} ·{" "}
                    {plural(shown.reduce((a, d) => a + d.chunkCount, 0), "passage")}
                  </div>
                </div>
                <label className="w-full sm:w-64">
                  <span className="sr-only">Filter documents</span>
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter by title or source"
                    className="field"
                  />
                </label>
              </div>
              {shown.length === 0 ? (
                <p className="hairline px-5 py-10 text-center text-sm text-[var(--muted)]">
                  {filter ? `Nothing here matches “${filter}”.` : "No documents in this collection yet."}
                </p>
              ) : (
                <ul>
                  {shown.map((d) => (
                    <DocumentRow
                      key={d.id}
                      doc={d}
                      open={openId === d.id}
                      showCollection={scope === ALL}
                      canWrite={canWrite}
                      onToggle={() => setOpenId(openId === d.id ? null : d.id)}
                      onDone={apply}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ value, label, node }: { value: number | string; label: string; node?: string }) {
  return (
    <div className="border-b border-[var(--border)] py-3.5 pr-4">
      <div className="metric flex items-center gap-2 text-3xl font-bold">
        {node && <span className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: node }} />}
        {value}
      </div>
      <div className="eyebrow mt-1">{label}</div>
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  title,
  count,
  meta = [],
  mono,
  restricted,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  count: number;
  meta?: (string | null)[];
  mono?: boolean;
  restricted?: boolean;
}) {
  const lines = meta.filter(Boolean) as string[];
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex w-full items-start justify-between gap-3 border-t border-[var(--border)] px-4 py-3 text-left transition-colors ${
        active ? "bg-[var(--text)] text-[var(--bg)]" : "hover:text-[var(--brand)]"
      }`}
    >
      <span className="min-w-0">
        <span className={`block break-words text-sm font-medium ${mono ? "mono" : ""}`}>{title}</span>
        {lines.map((l, i) => (
          <span
            key={i}
            className={`mt-0.5 flex items-center gap-1.5 text-xs ${active ? "text-[var(--bg)] opacity-75" : "text-[var(--muted)]"}`}
          >
            {i === 0 && restricted && <span aria-hidden className="inline-block h-1.5 w-1.5 bg-current" />}
            {l}
          </span>
        ))}
      </span>
      <span className={`metric mono shrink-0 text-sm ${active ? "" : "text-[var(--muted)]"}`}>{count}</span>
    </button>
  );
}

function SourceSummary({ sources, canWrite, onOpen }: { sources: SourceRow[]; canWrite: boolean; onOpen: () => void }) {
  const [now] = useState(() => Date.now());
  if (!sources.length) return null;
  return (
    <div className="panel p-4">
      <div className="eyebrow mb-3">Sources</div>
      <ul className="flex flex-col gap-2.5">
        {sources.map((s) => {
          const state = sourceState(s, now);
          return (
            <li key={s.type} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="inline-block h-2 w-2 shrink-0" style={{ background: TONE[state.tone] }} />
                <span className="truncate">{s.label}</span>
              </span>
              <span className={`shrink-0 text-xs ${state.tone === "bad" ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>{state.text}</span>
            </li>
          );
        })}
      </ul>
      {canWrite && (
        <button type="button" className="mt-4 text-xs font-medium uppercase tracking-[0.18em] hover:text-[var(--brand)]" onClick={onOpen}>
          Sync or connect →
        </button>
      )}
    </div>
  );
}

function EmptyState({
  canWrite,
  connected,
  onAdd,
  onConnect,
}: {
  canWrite: boolean;
  connected: SourceRow[];
  onAdd: () => void;
  onConnect: () => void;
}) {
  return (
    <section className="panel p-8 md:p-12">
      <div className="eyebrow text-[var(--brand)]">Empty</div>
      <h2 className="mt-3 max-w-2xl text-2xl md:text-3xl">
        Nothing to look up yet — the agents answer from memory and live sources only.
      </h2>
      <p className="mt-3 max-w-2xl text-[var(--text-soft)]">
        Add the documents an agent should be able to quote: policies, playbooks, contracts, meeting notes. File them
        in a collection and an agent can be scoped to it.
      </p>
      {canWrite ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {connected.length > 0 && (
            <button type="button" className="btn-brand min-h-11" onClick={onConnect}>
              Sync from {connected.map((s) => s.label).join(" or ")}
            </button>
          )}
          <button type="button" className={`${connected.length ? "btn" : "btn-brand"} min-h-11`} onClick={onAdd}>
            Paste a document
          </button>
          {connected.length === 0 && (
            <button type="button" className="btn min-h-11" onClick={onConnect}>
              Connect a source
            </button>
          )}
        </div>
      ) : (
        <p className="mt-6 text-sm text-[var(--muted)]">Ask an analyst or admin to add the first documents.</p>
      )}
    </section>
  );
}

function AddDocument({
  collections,
  defaultCollection,
  onCancel,
  onDone,
}: {
  collections: string[];
  defaultCollection: string;
  onCancel: () => void;
  onDone: (out: Result) => void;
}) {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [collection, setCollection] = useState(defaultCollection);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => firstField.current?.focus(), []);

  const words = content.trim() ? content.trim().split(/\s+/).length : 0;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onDone(await addDocumentAction({ title, source, collection, content }));
    setBusy(false);
  }

  return (
    <form onSubmit={add} className="panel p-5" aria-labelledby="add-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="add-title" className="text-xl">
          Add a document
        </h2>
        <button type="button" onClick={onCancel} className="text-xs font-medium uppercase tracking-[0.18em] hover:text-[var(--brand)]">
          Close
        </button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">Title</span>
          <input ref={firstField} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Refund policy" className="field" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">Collection</span>
          <input
            list="collections"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="Leave empty to keep it unfiled"
            className="field"
          />
          <datalist id="collections">
            {collections.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">Where it comes from</span>
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Employee handbook" className="field" />
        </label>
      </div>
      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Text</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={8}
          placeholder="Paste the document text. It is split into passages and indexed so an agent can find the part it needs."
          className="field resize-y"
          required
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-[var(--muted)]">{words ? plural(words, "word") : "Plain text works best."}</span>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="btn min-h-11">
            Cancel
          </button>
          <button type="submit" disabled={busy || !content.trim()} className="btn-brand min-h-11">
            {busy ? "Indexing…" : "Add to knowledge"}
          </button>
        </div>
      </div>
    </form>
  );
}

function Sources({
  sources,
  onSynced,
  onClose,
}: {
  sources: SourceRow[];
  onSynced: (out: Result) => void;
  onClose: () => void;
}) {
  const [collection, setCollection] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  async function sync(type: string) {
    setBusy(type);
    setNote(null);
    setError(null);
    const out = await syncSourceAction(type, collection);
    if ("error" in out) setError(out.error);
    else {
      setNote(`Synced: ${out.summary}`);
      onSynced(out.snapshot);
    }
    setBusy(null);
  }

  return (
    <section className="panel p-5" aria-labelledby="sources-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="sources-title" className="text-xl">
          Sources
        </h2>
        <button type="button" onClick={onClose} className="text-xs font-medium uppercase tracking-[0.18em] hover:text-[var(--brand)]">
          Close
        </button>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        A source pulls documents in when you sync it. Syncing again replaces that source&apos;s documents, so nothing is
        duplicated.
      </p>
      <label className="mt-4 block max-w-sm">
        <span className="mb-1 block text-xs text-[var(--muted)]">File synced documents under (optional)</span>
        <input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="e.g. client-projects" className="field" />
      </label>
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {sources.map((s) => {
          const setup = setupFor(s.type);
          return (
            <li key={s.type} className="inset flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-bold">{s.label}</h3>
                <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2"
                    style={{ background: s.configured ? "var(--ai)" : "var(--faint)" }}
                  />
                  {s.configured ? "Connected" : "Not connected"}
                </span>
              </div>
              {setup && <p className="text-sm text-[var(--text-soft)]">{setup.what}</p>}
              {s.defaultCollection && (
                <p className="text-xs text-[var(--muted)]">
                  Filed under <code className="text-[var(--text-soft)]">{s.defaultCollection}</code>
                  {s.type.startsWith("sharepoint:") ? "." : " unless you name a collection above."}
                </p>
              )}
              {s.configured && s.autoSyncMinutes ? (
                <div className="text-xs text-[var(--muted)]">
                  <p>Syncs by itself every {plural(s.autoSyncMinutes, "minute")}.</p>
                  {s.lastSync?.at && s.lastSync.ok !== false && (
                    <p className="mt-1">
                      Last sync {rel(s.lastSync.at, now).toLowerCase()}: {s.lastSync.summary}
                    </p>
                  )}
                  {s.lastSync?.ok === false && (
                    <p role="alert" className="mt-1 text-[var(--danger)]">
                      Last sync failed {rel(s.lastSync.at, now).toLowerCase()}: {s.lastSync.error}
                    </p>
                  )}
                </div>
              ) : null}
              {s.configured ? (
                <button type="button" onClick={() => sync(s.type)} disabled={busy !== null} className="btn-brand min-h-11 self-start">
                  {busy === s.type ? "Syncing…" : "Sync now"}
                </button>
              ) : (
                <div className="text-xs text-[var(--muted)]">
                  To connect it, set{" "}
                  {(setup?.env ?? ["its credentials"]).map((v, i, all) => (
                    <span key={v}>
                      <code className="text-[var(--text-soft)]">{v}</code>
                      {i < all.length - 1 ? ", " : ""}
                    </span>
                  ))}{" "}
                  as Fly secrets and redeploy.
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {note && (
        <p role="status" className="mt-3 text-sm text-[var(--ai)]">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  );
}

function Ask({ onOpen }: { onOpen: (documentId: string) => void }) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [chunks, setChunks] = useState<RetrievedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    const out = await testRetrievalAction(query);
    if ("error" in out) {
      setError(out.error);
      setChunks(null);
    } else {
      setChunks(out.chunks);
      setAsked(query.trim());
    }
    setBusy(false);
  }

  return (
    <section className="panel p-5" aria-labelledby="ask-title">
      <h2 id="ask-title" className="text-xl">
        Ask what an agent would find
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        The same search an agent runs before it answers, limited to what you can read.
      </p>
      <form onSubmit={run} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">Question</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. What is our refund window?"
            className="field min-h-11"
          />
        </label>
        <button type="submit" disabled={busy || !query.trim()} className="btn-brand min-h-11">
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {chunks && (
        <div className="mt-5" aria-live="polite">
          <div className="eyebrow mb-2">
            {chunks.length ? `Top ${plural(chunks.length, "passage")} for “${asked}”` : `Nothing found for “${asked}”`}
          </div>
          <ol className="flex flex-col">
            {chunks.map((c, i) => {
              const pct = Math.round(Math.max(0, Math.min(1, c.score)) * 100);
              return (
                <li key={`${c.documentId}-${c.chunkIndex}`} className="border-t border-[var(--border)] py-3">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <button
                      type="button"
                      onClick={() => onOpen(c.documentId)}
                      className="min-w-0 text-left text-sm font-bold hover:text-[var(--brand)]"
                    >
                      <span className="mono mr-2 text-xs font-normal text-[var(--muted)]">{i + 1}</span>
                      {c.title || "Untitled"}
                      <span className="ml-2 text-xs font-normal text-[var(--muted)]">passage {c.chunkIndex + 1}</span>
                    </button>
                    <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
                      <span aria-hidden className="relative inline-block h-1.5 w-24 bg-[var(--ai-soft)]">
                        <span className="absolute inset-y-0 left-0 bg-[var(--ai)]" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="mono w-16 text-right">{pct}% match</span>
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-[var(--text-soft)]">{c.preview}…</p>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}

function DocumentRow({
  doc,
  open,
  showCollection,
  canWrite,
  onToggle,
  onDone,
}: {
  doc: DocRow;
  open: boolean;
  showCollection: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onDone: (out: Result) => void;
}) {
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    // A failed load stays failed until the row is reopened — never a retry loop.
    if (!open || detail || loading || loadError) return;
    setLoading(true);
    setLoadError(null);
    getDocumentAction(doc.id).then((out) => {
      if ("error" in out) setLoadError(out.error);
      else setDetail(out);
      setLoading(false);
    });
  }, [open, detail, loading, loadError, doc.id]);

  useEffect(() => {
    if (!open) setLoadError(null);
  }, [open]);

  async function del() {
    setDeleting(true);
    onDone(await deleteDocumentAction(doc.id));
    setDeleting(false);
    setConfirming(false);
  }

  const meta = detail ? Object.entries(detail.metadata ?? {}).filter(([, v]) => v != null && v !== "") : [];
  const origin = doc.source || (doc.sourceType === "manual" ? "Added by hand" : doc.sourceType);

  return (
    <li id={`doc-${doc.id}`} className="border-t border-[var(--border)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-start gap-3 px-5 py-4 text-left transition-colors ${open ? "bg-[var(--panel-2)]" : "hover:bg-[var(--panel-2)]"}`}
      >
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`mt-1.5 h-2.5 w-2.5 shrink-0 text-[var(--muted)] transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{doc.title || "Untitled"}</span>
            {showCollection && doc.collection && (
              <span className="mono border border-[var(--border-strong)] px-1.5 py-0.5 text-[0.68rem] text-[var(--text-soft)]">
                {doc.collection}
              </span>
            )}
          </span>
          {!open && doc.preview && (
            <span className="mt-1 line-clamp-2 block text-sm text-[var(--text-soft)]">{doc.preview}…</span>
          )}
          <span className="mt-1.5 block text-xs text-[var(--muted)]">
            {origin} · {plural(doc.chunkCount, "passage")} · Added {fmtDate(doc.createdAt)}
          </span>
        </span>
      </button>

      {open && (
        <div className="bg-[var(--panel-2)] px-5 pb-5 pl-[2.6rem]">
          {loading ? (
            <p className="text-sm text-[var(--muted)]">Loading…</p>
          ) : loadError ? (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {loadError}
            </p>
          ) : detail ? (
            <div className="flex flex-col gap-3">
              {meta.length > 0 && (
                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  {meta.map(([k, v]) => (
                    <div key={k} className="flex gap-1.5">
                      <dt className="text-[var(--muted)]">{k}</dt>
                      <dd className="mono text-[var(--text-soft)]">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <ol className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto pr-1">
                {detail.chunks.map((c) => (
                  <li key={c.chunkIndex} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 bg-[var(--panel)] p-3">
                    <span className="mono text-xs text-[var(--muted)]">{c.chunkIndex + 1}</span>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{c.content}</p>
                  </li>
                ))}
              </ol>
              {canWrite && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {confirming ? (
                    <>
                      <span className="text-sm">Delete this document and its {plural(doc.chunkCount, "passage")}?</span>
                      <button type="button" onClick={del} disabled={deleting} className="btn min-h-11 border-[var(--danger)] text-[var(--danger)]">
                        {deleting ? "Deleting…" : "Delete"}
                      </button>
                      <button type="button" onClick={() => setConfirming(false)} className="btn min-h-11">
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--muted)] hover:text-[var(--danger)]"
                    >
                      Delete document
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}
