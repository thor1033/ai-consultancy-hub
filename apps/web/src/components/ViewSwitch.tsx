"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { VIEWS, VIEW_INFO, type View } from "@/lib/views";
import { setViewAction } from "@/app/settings/actions";
import { useView } from "./ViewProvider";

// Simple · Standard · Expert, in the rail. One click, and the whole hub
// redraws in that view; the choice is kept for this person (docs/views.md).
export function ViewSwitch({ compact = false }: { compact?: boolean }) {
  const { view } = useView();
  const router = useRouter();
  const [pending, start] = useTransition();
  const pick = (v: View) =>
    start(async () => {
      await setViewAction(v);
      router.refresh();
    });
  return (
    <div role="radiogroup" aria-label="How much of the hub you see" className={`grid grid-cols-3 border border-[var(--border)] bg-[var(--panel)] ${pending ? "opacity-60" : ""}`}>
      {VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={view === v}
          title={VIEW_INFO[v].tagline}
          disabled={pending}
          onClick={() => view !== v && pick(v)}
          className={`min-h-9 px-1 ${compact ? "text-[0.7rem]" : "text-[0.74rem]"} font-medium transition-colors ${
            view === v ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--muted)] hover:text-[var(--text)]"
          }`}
        >
          {VIEW_INFO[v].label}
        </button>
      ))}
    </div>
  );
}
