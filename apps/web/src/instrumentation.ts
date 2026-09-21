/**
 * Next's server-start hook — the only place the hub gets to run something that
 * is not a request.
 *
 * That is what the scheduler needs: the container is long-lived (Fly, not a
 * serverless function), so a plain interval here is a real clock. It stays off
 * unless HUB_SCHEDULER=1 — see lib/scheduler.ts for why the default is off.
 */
export async function register() {
  // Runs once per server process; the edge runtime has no timers or database.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
