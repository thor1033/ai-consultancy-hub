"use client";

import { useState, useTransition } from "react";
import { createDeckAction } from "./actions";

export function NewDeck({ collections }: { collections: string[] }) {
  const [title, setTitle] = useState("");
  const [collection, setCollection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          // Redirects to the new deck on success; only a refusal comes back.
          const res = await createDeckAction(title, collection);
          if (res?.error) setError(res.error);
        });
      }}
    >
      <div className="eyebrow">New deck</div>
      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">Title</span>
        <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Aurora steering group, November" required />
      </label>
      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-[var(--muted)]">What it is about</span>
        <select className="field" value={collection} onChange={(e) => setCollection(e.target.value)}>
          <option value="">Everything you may read</option>
          {collections.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-[var(--muted)]">
          Questions answered live draw from this collection. A deck about a restricted collection is visible only to people who
          may read it.
        </span>
      </label>
      <button type="submit" className="btn-brand mt-4 min-h-11 w-full" disabled={pending || !title.trim()}>
        {pending ? "Creating…" : "Create deck"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </form>
  );
}
