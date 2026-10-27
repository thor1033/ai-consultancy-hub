"use client";

import { useEffect, useState } from "react";

// The agent page's tabs. Every panel stays mounted and is only hidden, so a
// conversation in progress survives a look at the agent's memory. The open tab
// lives in the URL hash: it can be linked to, and any `<a href="#memory">` on
// the page switches tabs without a server round trip.

export interface TabSpec {
  id: string;
  label: string;
  count?: number;
  content: React.ReactNode;
}

export function AgentTabs({ tabs }: { tabs: TabSpec[] }) {
  const [open, setOpen] = useState(tabs[0]?.id ?? "");

  useEffect(() => {
    const read = () => {
      const id = window.location.hash.slice(1);
      if (tabs.some((t) => t.id === id)) setOpen(id);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [tabs]);

  function pick(id: string) {
    setOpen(id);
    // replaceState, not location.hash: no scroll jump and no history entry per tab.
    window.history.replaceState(null, "", `#${id}`);
  }

  return (
    <div className="mt-6">
      <div
        role="tablist"
        aria-label="Agent"
        className="-mx-5 flex gap-1 overflow-x-auto border-b border-[var(--border-strong)] px-5 lg:mx-0 lg:px-0"
      >
        {tabs.map((t) => {
          const active = t.id === open;
          return (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={active}
              aria-controls={`panel-${t.id}`}
              onClick={() => pick(t.id)}
              className={`-mb-px flex min-h-11 shrink-0 items-center gap-2 border-b-[3px] px-3 text-sm font-medium transition-colors ${
                active
                  ? "border-[var(--brand)] text-[var(--text)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={`mono text-xs ${active ? "text-[var(--brand)]" : "text-[var(--faint)]"}`}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`panel-${t.id}`}
          aria-labelledby={`tab-${t.id}`}
          hidden={t.id !== open}
          className="pt-6"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
