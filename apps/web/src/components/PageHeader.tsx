// Page header for every screen: a micro eyebrow, a bold sentence-case title,
// an optional one-line subtitle, and a slot for actions. Restrained — the
// work is the panels below, not the header.
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
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="text-2xl md:text-3xl">{title}</h1>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
