"use client";

export function PrintToolbar({ title, count }: { title: string; count: number }) {
  return (
    <div className="deck-print-toolbar sticky top-0 z-10 mx-auto mb-6 flex w-[1280px] max-w-full flex-wrap items-center gap-3 bg-[#5b5852] py-3 text-sm text-white">
      <span className="min-w-0 flex-1 truncate font-medium">
        {title} · {count} page{count === 1 ? "" : "s"}
      </span>
      <span className="text-xs text-white/70">In the dialog: Save as PDF, margins None, background graphics on.</span>
      <button type="button" className="bg-white px-4 py-2 text-sm font-medium text-black hover:bg-[var(--tk-red)] hover:text-white" onClick={() => window.print()}>
        Save as PDF
      </button>
    </div>
  );
}
