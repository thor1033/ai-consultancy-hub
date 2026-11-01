"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SENSITIVITY_WORDS } from "@/lib/sensitivityWords";
import { setServerSensitivityAction } from "../actions";

type Label = keyof typeof SENSITIVITY_WORDS;

// A connection's sensitivity label (docs/sensitivity.md), for admins.
export function ServerLabel({ name, sensitivity }: { name: string; sensitivity: Label }) {
  const router = useRouter();
  const [value, setValue] = useState<Label>(sensitivity);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <section className="panel p-5 md:p-6">
      <div className="eyebrow">Sensitivity</div>
      <p className="mt-2 text-sm text-[var(--text-soft)]">
        How carefully the hub treats what this connection returns. Every conversation that has it is treated the same way.
      </p>
      <label className="mt-3 block">
        <span className="sr-only">Sensitivity of this connection</span>
        <select
          className="field"
          value={value}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value as Label;
            const before = value;
            setValue(next);
            setError(null);
            start(async () => {
              const out = await setServerSensitivityAction(name, next);
              if ("error" in out) {
                setValue(before);
                setError(out.error);
              } else router.refresh();
            });
          }}
        >
          {(Object.keys(SENSITIVITY_WORDS) as Label[]).map((l) => (
            <option key={l} value={l}>
              {SENSITIVITY_WORDS[l].label}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-sm text-[var(--muted)]">{SENSITIVITY_WORDS[value].means}</p>
      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
    </section>
  );
}
