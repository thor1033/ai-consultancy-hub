"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { View } from "@/lib/views";
import { ThemeToggle } from "@/components/ThemeToggle";
import { setViewAction } from "./actions";

export function ViewChooser({
  current,
  canReset,
  fromText,
  views,
  signedIn,
}: {
  current: View;
  canReset: boolean;
  fromText: string;
  views: { id: View; label: string; tagline: string; who: string; shows: string[] }[];
  signedIn: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const pick = (v: View | null) =>
    start(async () => {
      await setViewAction(v);
      router.refresh();
    });

  return (
    <div className="mt-6 flex flex-col gap-6">
      <section className="panel p-5 md:p-6">
        <div className="eyebrow">Your view</div>
        <ul className="mt-4 grid gap-3 md:grid-cols-3">
          {views.map((v) => {
            const on = v.id === current;
            return (
              <li key={v.id}>
                <button
                  type="button"
                  disabled={pending || !signedIn}
                  onClick={() => !on && pick(v.id)}
                  aria-pressed={on}
                  className={`flex h-full w-full flex-col border p-4 text-left transition-colors ${
                    on ? "border-[var(--text)] bg-[var(--panel)]" : "border-[var(--border-strong)] hover:border-[var(--brand)]"
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold">{v.label}</span>
                    {on && <span className="eyebrow text-[var(--brand)]">Current</span>}
                  </span>
                  <span className="mt-1 text-sm font-medium">{v.tagline}</span>
                  <span className="mt-1 text-xs text-[var(--muted)]">{v.who}</span>
                  <ul className="mt-3 flex flex-col gap-1.5 text-sm text-[var(--text-soft)]">
                    {v.shows.map((s) => (
                      <li key={s} className="flex gap-2">
                        <span aria-hidden className="mt-2 inline-block h-1.5 w-1.5 shrink-0 bg-[var(--ai)]" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-sm text-[var(--muted)]">
          {fromText}
          {canReset && (
            <>
              {" "}
              <button type="button" className="underline underline-offset-2 hover:text-[var(--text)]" disabled={pending} onClick={() => pick(null)}>
                Go back to the default
              </button>
              .
            </>
          )}
        </p>
      </section>

      <section className="panel flex flex-wrap items-center justify-between gap-3 p-5 md:p-6">
        <div>
          <div className="eyebrow">Light or dark</div>
          <p className="mt-1 text-sm text-[var(--muted)]">Follows your device until you pick one.</p>
        </div>
        <ThemeToggle />
      </section>
    </div>
  );
}
