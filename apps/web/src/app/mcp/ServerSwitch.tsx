"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setServerEnabledAction } from "./actions";

// The kill switch on a server's page. Switching off asks first and says what it
// costs, because it cuts every agent that uses the server off at once.
export function ServerSwitch({ name, enabled, users }: { name: string; enabled: boolean; users: string[] }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const flip = (next: boolean) =>
    start(async () => {
      const res = await setServerEnabledAction(name, next);
      setConfirm(false);
      if ("error" in res) setError(res.error);
      else {
        setError(null);
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      {confirm ? (
        <div className="panel notice-warning flex max-w-sm flex-col gap-3 p-4 text-sm">
          <p>
            Switch it off for every run?
            {users.length > 0 && (
              <span className="text-[var(--text-soft)]"> {users.join(", ")} will lose its tools until it is back on.</span>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn min-h-10 border-[var(--danger)] text-[var(--danger)]"
              disabled={pending}
              onClick={() => flip(false)}
            >
              {pending ? "Switching off…" : "Switch off"}
            </button>
            <button type="button" className="btn min-h-10" onClick={() => setConfirm(false)}>
              Keep it on
            </button>
          </div>
        </div>
      ) : enabled ? (
        <button type="button" className="btn min-h-11" disabled={pending} onClick={() => setConfirm(true)}>
          Switch off…
        </button>
      ) : (
        <button type="button" className="btn-brand min-h-11" disabled={pending} onClick={() => flip(true)}>
          {pending ? "Switching on…" : "Switch on"}
        </button>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
