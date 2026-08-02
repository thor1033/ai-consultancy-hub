// Compact, consistent page header for every console screen: a title, an optional
// one-line subtitle, and a slot for actions. Deliberately restrained — the work
// is the panels below, not the header.
export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow && (
          <div className="mb-1 text-[0.68rem] uppercase tracking-[0.16em] text-[var(--muted)]">
            {eyebrow}
          </div>
        )}
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {subtitle && (
          <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
