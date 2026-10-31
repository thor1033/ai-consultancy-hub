"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importAction, previewImportAction, type ImportPreview } from "./actions";

// Paste a GitHub link, read what the hub would make of it, decide what it
// becomes. The preview shows the whole file: an imported brief is a system
// prompt a person is about to hand an agent, and it was written by a stranger.

export function ImportForm({ canManage, functions, owners }: { canManage: boolean; functions: string[]; owners: string[] }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [as, setAs] = useState<"agent" | "skill">("agent");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState("");
  const [functionName, setFunctionName] = useState("");
  const [owner, setOwner] = useState("");
  const [addHubRules, setAddHubRules] = useState(true);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, start] = useTransition();

  function doPreview() {
    setMessage(null);
    start(async () => {
      const res = await previewImportAction(url);
      if ("error" in res) {
        setPreview(null);
        setMessage({ text: res.error, error: true });
        return;
      }
      setPreview(res);
      setAs(res.looksLike === "skill" ? "skill" : "agent");
      setSlug(res.suggestedSlug);
      setName(res.parsed.name || res.suggestedSlug);
      setDescription(res.parsed.description);
      setAgentId(res.agents[0]?.id ?? "");
    });
  }

  function doImport() {
    setMessage(null);
    start(async () => {
      const res = await importAction({ url, as, slug, name, description, agentId, functionName, owner, addHubRules });
      if ("error" in res) setMessage({ text: res.error, error: true });
      else router.push(res.href);
    });
  }

  const p = preview?.parsed;
  const words = p ? p.body.split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className="mt-6 flex flex-col gap-6">
      <form
        className="panel p-5 md:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          doPreview();
        }}
      >
        <div className="eyebrow">The file</div>
        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-[var(--muted)]">GitHub link to a SKILL.md folder, an agent&apos;s .md file, or a repository</span>
          <input className="field mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/anthropics/skills/tree/main/skills/…" required />
        </label>
        <p className="mt-1.5 text-xs text-[var(--muted)]">
          A folder link reads its SKILL.md; a repository link reads the root SKILL.md; a file link reads that file. Only github.com is read, from
          this hub&apos;s server, up to 256 KB.
        </p>
        <button type="submit" disabled={pending} className="btn mt-4 min-h-11">
          {pending && !preview ? "Reading…" : "Read it"}
        </button>
        {message && !preview && <p className="mt-3 text-sm text-[var(--danger)]">{message.text}</p>}
      </form>

      {preview && p && (
        <>
          <section className="panel p-5 md:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="eyebrow">What it is</div>
              <span className="text-xs text-[var(--muted)]">
                {preview.looksLike === "skill" ? "A SKILL.md (Agent Skills standard)" : preview.looksLike === "agent" ? "An agent file: a brief with frontmatter" : "A Markdown file with no frontmatter"}
              </span>
            </div>
            <h2 className="mt-2 text-2xl">{p.name || <span className="text-[var(--muted)]">(no name in the file)</span>}</h2>
            <p className="mt-1 text-[var(--text-soft)]">{p.description || <span className="text-[var(--muted)]">No description in the file.</span>}</p>
            <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="From" value={`${preview.source.repo} @ ${preview.source.ref}`} />
              <Fact label="License" value={preview.source.license ?? "not found"} warn={!preview.source.license || preview.source.license === "unrecognised" || preview.source.license === "source-available"} />
              <Fact label="Length" value={`${words} words`} warn={words > 2500} />
              <Fact label="Asks for" value={p.tools.length ? `tools: ${p.tools.join(", ")}` : p.model ? `model: ${p.model}` : "nothing"} />
            </dl>
            {p.tools.length > 0 && (
              <p className="mt-2 text-xs text-[var(--muted)]">
                The tools it names are another product&apos;s. Nothing is granted by importing: its tool servers and memory are chosen on its page, from what
                this hub has.
              </p>
            )}
            {Object.keys(p.extra).length > 0 && (
              <p className="mt-2 text-xs text-[var(--muted)]">Other frontmatter, not used: {Object.entries(p.extra).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>
            )}
            <details className="mt-4" open>
              <summary className="cursor-pointer text-sm">The instructions, as written</summary>
              <pre className="inset mono mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed">{p.body}</pre>
            </details>
          </section>

          <form
            className="panel p-5 md:p-6"
            onSubmit={(e) => {
              e.preventDefault();
              doImport();
            }}
          >
            <div className="eyebrow">What it becomes</div>
            <fieldset className="mt-3">
              <legend className="sr-only">What it becomes</legend>
              <ul className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ["agent", "A new agent", "The instructions become its brief. It gets no tools and keeps memory until you say otherwise on its page."],
                    ["skill", "A skill on an existing agent", "The instructions become the skill's standing text; the caller adds the request. The agent's brief stays its own."],
                  ] as const
                ).map(([id, label, help]) => (
                  <li key={id}>
                    <label className={`flex cursor-pointer items-start gap-3 border p-3.5 ${as === id ? "border-[var(--text)] bg-[var(--panel)]" : "border-[var(--border-strong)] hover:border-[var(--brand)]"}`}>
                      <input type="radio" name="as" className="mt-0.5 h-4 w-4 accent-[var(--text)]" checked={as === id} onChange={() => setAs(id)} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="mt-0.5 block text-xs text-[var(--muted)]">{help}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--muted)]">Name</span>
                <input className="field" value={name} onChange={(e) => setName(e.target.value)} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--muted)]">Slug</span>
                <input className="field mono" value={slug} onChange={(e) => setSlug(e.target.value)} required />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs text-[var(--muted)]">What it is for</span>
                <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
              {as === "skill" ? (
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs text-[var(--muted)]">On which agent</span>
                  <select className="field" value={agentId} onChange={(e) => setAgentId(e.target.value)} required>
                    {preview.agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className="block">
                    <span className="mb-1 block text-xs text-[var(--muted)]">Function</span>
                    <input className="field" list="import-functions" value={functionName} onChange={(e) => setFunctionName(e.target.value)} placeholder="Delivery" />
                    <datalist id="import-functions">{functions.map((f) => <option key={f} value={f} />)}</datalist>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-[var(--muted)]">Owner</span>
                    <input className="field" list="import-owners" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Thor Simonsen" />
                    <datalist id="import-owners">{owners.map((o) => <option key={o} value={o} />)}</datalist>
                  </label>
                </>
              )}
            </div>
            <label className="mt-4 flex cursor-pointer items-start gap-3">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--text)]" checked={addHubRules} onChange={(e) => setAddHubRules(e.target.checked)} />
              <span className="min-w-0 text-sm">
                <span className="block font-medium">Add the hub&apos;s standing rules to the instructions</span>
                <span className="block text-xs text-[var(--muted)]">
                  The file was written for another product. This appends three rules: writes wait for approval, memory first, say what you cannot do.
                </span>
              </span>
            </label>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button type="submit" disabled={pending || !canManage} className="btn-brand min-h-11">
                {pending ? "Importing…" : as === "skill" ? "Add the skill" : "Create the agent"}
              </button>
              {!canManage && <span className="text-xs text-[var(--warning)]">Only an admin can import; you can read the preview.</span>}
            </div>
            {message && <p className={`mt-3 text-sm ${message.error ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>{message.text}</p>}
            <p className="mt-4 text-xs text-[var(--muted)]">
              The file is read again at import and its hash recorded with the link and the license, so the row says where it came from and whether
              upstream has changed since.
            </p>
          </form>
        </>
      )}
    </div>
  );
}

function Fact({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className={`mt-0.5 ${warn ? "text-[var(--warning)]" : ""}`}>{value}</dd>
    </div>
  );
}
