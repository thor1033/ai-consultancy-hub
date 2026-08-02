// Next.js instrumentation: runs once when the server process starts. It drives
// scheduled automations by pinging the /api/schedules/tick endpoint on a minute
// interval — so a self-hosted hub runs schedules with no external cron.
//
// We intentionally do NOT import the runner here: it pulls the MCP stdio SDK
// (child_process), which must not be bundled into the instrumentation graph. The
// endpoint runs that work in a normal Node route context instead. In serverless
// deploys, disable this (HUB_DISABLE_SCHEDULER=1) and hit the endpoint from a real
// cron. The tick is a cheap no-op when nothing is due.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.HUB_DISABLE_SCHEDULER === "1") return;

  const g = globalThis as unknown as { __hubScheduler?: boolean };
  if (g.__hubScheduler) return; // survive dev hot-reload
  g.__hubScheduler = true;

  const port = process.env.PORT || "3000";
  const base = process.env.HUB_SELF_URL || `http://127.0.0.1:${port}`;
  const url = `${base}/api/schedules/tick`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;

  const tick = async () => {
    try {
      const res = await fetch(url, { method: "POST", headers });
      if (res.ok) {
        const j = (await res.json()) as { ran?: number };
        if (j.ran && j.ran > 0) console.log(`[scheduler] ran ${j.ran} scheduled skill run(s)`);
      }
    } catch {
      /* server may still be starting, or briefly unavailable */
    }
  };

  setInterval(tick, 60_000);
  setTimeout(tick, 10_000); // first sweep once the server is listening
  console.log("[scheduler] in-process scheduler started (60s interval)");
}
