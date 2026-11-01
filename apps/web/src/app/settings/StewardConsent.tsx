"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setStewardConsentAction } from "./actions";

// "Let the Context Steward read my conversations" — each person's own switch
// (docs/context-steward.md). Off until they turn it on.
export function StewardConsent({ allowed }: { allowed: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const flip = () =>
    start(async () => {
      const res = await setStewardConsentAction(!allowed);
      if ("error" in res) setError(res.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  return (
    <section className="panel p-5 md:p-6">
      <div className="eyebrow">Context Steward</div>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-[var(--text-soft)]">
          The Context Steward looks through conversations with agents for decisions, corrections and facts worth keeping, and suggests filing
          them. It never files anything itself: every suggestion waits for a person&apos;s approval. It reads your conversations only if you
          allow it here, and stops as soon as you switch it off.
        </p>
        <button type="button" role="switch" aria-checked={allowed} disabled={pending} onClick={flip} className={allowed ? "btn-brand min-h-11" : "btn min-h-11"}>
          {allowed ? "Allowed — switch off" : "Not allowed — allow it"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
    </section>
  );
}
