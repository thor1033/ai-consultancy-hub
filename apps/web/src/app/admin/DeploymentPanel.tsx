import type { PostureItem, Recipient } from "@/lib/deployment";

// This deployment (lib/deployment.ts): its settings in words, and where the
// organisation's data goes from here — the list a data processing agreement's
// annex needs, read from the deployment itself rather than from a document
// that can drift from it.

const MARK: Record<PostureItem["status"], { text: string; color: string }> = {
  ok: { text: "OK", color: "var(--positive)" },
  warn: { text: "Check", color: "var(--warning, var(--brand))" },
  bad: { text: "Fix", color: "var(--danger)" },
};

export function DeploymentPanel({ items, recipients }: { items: PostureItem[]; recipients: Recipient[] }) {
  return (
    <div className="space-y-6">
      <ul className="panel divide-y divide-[var(--border)]">
        {items.map((i) => (
          <li key={i.key} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1.4fr)] md:gap-4">
            <span className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: MARK[i.status].color }}>
              {MARK[i.status].text}
            </span>
            <span>
              <span className="block text-[var(--text-soft)]">{i.label}</span>
              <span className="font-medium">{i.value}</span>
            </span>
            <span className="text-[var(--muted)]">{i.note ?? ""}</span>
          </li>
        ))}
      </ul>
      <div>
        <h3 className="text-sm font-semibold">Who receives your data</h3>
        <ul className="panel mt-2 divide-y divide-[var(--border)]">
          {recipients.map((r, n) => (
            <li key={`${r.who}-${n}`} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)] md:gap-4">
              <span className="font-medium">{r.who}</span>
              <span className="text-[var(--text-soft)]">{r.what}</span>
              <span className="text-[var(--muted)]">
                {r.where} · {r.account}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
