"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { removeConnectionAction, updateConnectionAction, type ConnectionResult } from "../actions";

// Changing or removing a connection added on the Connections page. The saved
// address and token are never sent here: changing one means typing a new one,
// and an empty field keeps what is saved.
export function ConnectionSettings({
  name,
  label,
  description,
  host,
  hasToken,
  users,
}: {
  name: string;
  label: string;
  description: string;
  host?: string;
  hasToken: boolean;
  users: string[];
}) {
  const router = useRouter();
  const [newLabel, setLabel] = useState(label);
  const [newDescription, setDescription] = useState(description);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = (force: boolean) =>
    start(async () => {
      const res = await updateConnectionAction(name, {
        label: newLabel,
        description: newDescription,
        url: url || undefined,
        token: token || undefined,
        removeToken,
        force,
      });
      setResult(res);
      if ("ok" in res) {
        setUrl("");
        setToken("");
        setRemoveToken(false);
        router.refresh();
      }
    });

  const remove = () =>
    start(async () => {
      const res = await removeConnectionAction(name);
      if ("error" in res) setRemoveError(res.error);
      else router.push("/mcp");
    });

  return (
    <section className="panel p-5 md:p-6">
      <div className="eyebrow">Change or remove</div>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Added on the Connections page{host ? `, at ${host}` : ""}. {hasToken ? "Its token is stored encrypted." : "It has no token."} Leave an
        empty field to keep what is saved.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">Name</span>
          <input className="field" value={newLabel} onChange={(e) => setLabel(e.target.value)} maxLength={60} required />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">What it is for</span>
          <input className="field" value={newDescription} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">New address</span>
          <input className="field" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Keep the saved one" inputMode="url" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">New token</span>
          <input
            className="field"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              if (e.target.value) setRemoveToken(false);
            }}
            placeholder={hasToken ? "Keep the saved one" : "None saved"}
            disabled={removeToken}
          />
        </label>
        {hasToken && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={removeToken} onChange={(e) => setRemoveToken(e.target.checked)} />
            Remove the saved token
          </label>
        )}
        {result && "error" in result && (
          <div role="alert" className="text-sm text-[var(--danger)]">
            <p>{result.error}</p>
            {result.canForce && (
              <button type="button" className="btn mt-2 min-h-10" disabled={pending} onClick={() => save(true)}>
                Save it anyway
              </button>
            )}
          </div>
        )}
        {result && "ok" in result && (
          <p role="status" className="text-sm text-[var(--text-soft)]">
            Saved{result.tools !== null ? `; it answered with ${result.tools} tool${result.tools === 1 ? "" : "s"}` : ""}.
          </p>
        )}
        <div>
          <button type="submit" className="btn-brand min-h-10" disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>

      <div className="mt-5 border-t border-[var(--border)] pt-4">
        {confirm ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Remove this connection?
              {users.length > 0 && (
                <span className="text-[var(--text-soft)]"> {users.join(", ")} will lose its tools, and their runs will say it is gone.</span>
              )}
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn min-h-10 border-[var(--danger)] text-[var(--danger)]" disabled={pending} onClick={remove}>
                Remove it
              </button>
              <button type="button" className="btn min-h-10" onClick={() => setConfirm(false)}>
                Keep it
              </button>
            </div>
            {removeError && <p className="text-[var(--danger)]">{removeError}</p>}
          </div>
        ) : (
          <button type="button" className="text-sm text-[var(--danger)] underline-offset-2 hover:underline" onClick={() => setConfirm(true)}>
            Remove this connection
          </button>
        )}
      </div>
    </section>
  );
}
