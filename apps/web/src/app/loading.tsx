// Shown the instant a navigation starts, for every route, until the page's
// server render arrives. Before this existed a click on a slow page (one that
// introspects MCP servers, say) changed nothing on screen for seconds, which
// reads as "the click did not take" — so people clicked again and restarted
// the wait. A static skeleton in the page's own shape: no pulse, no fade, the
// system has no motion for its own sake.
export default function Loading() {
  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8" aria-busy="true" aria-label="Loading">
      <div className="mb-6">
        <div className="h-3 w-20 bg-[var(--panel-2)]" />
        <div className="mt-3 h-7 w-64 bg-[var(--panel-2)]" />
        <div className="mt-3 h-3 w-96 max-w-full bg-[var(--panel-2)]" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="panel p-5">
            <div className="h-4 w-32 bg-[var(--panel-2)]" />
            <div className="mt-3 h-3 w-full bg-[var(--panel-2)]" />
            <div className="mt-2 h-3 w-3/4 bg-[var(--panel-2)]" />
          </div>
        ))}
      </div>
    </main>
  );
}
