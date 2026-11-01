import { listSources, syncSource, describeSync } from "@ai-hub/rag";
import { claimSourceSync, finishSourceSync } from "@ai-hub/db";

/*
 * Knowledge sources that sync on the clock (the shared SharePoint folders,
 * packages/rag/src/sharepoint.ts). Driven by the scheduler's ticker, so it
 * runs only where HUB_SCHEDULER=1, for the same reason schedules do.
 *
 * Every machine ticks; claimSourceSync lets exactly one of them start a given
 * source's sync, and a sync that died is reclaimed once its interval passes.
 * The outcome is recorded either way and shown on /knowledge: a background
 * sync that stopped working has to say so somewhere a person looks, not only
 * in a log line nobody reads.
 */

let running = false;

/** Sync every due source, one after another. Never throws. */
export async function syncDueSources(): Promise<void> {
  // A first sync of a full folder embeds every file and can outlast a tick;
  // the next tick must not start a second pass on this machine.
  if (running) return;
  running = true;
  try {
    for (const source of listSources()) {
      if (!source.configured || !source.autoSyncMinutes) continue;
      let claimed = false;
      try {
        claimed = await claimSourceSync(source.type, source.autoSyncMinutes);
        if (!claimed) continue;
        const result = await syncSource(source.type);
        const summary = describeSync(result);
        await finishSourceSync(source.type, { ok: true, summary });
        if (result.documents || result.removed || result.createdCollections?.length || result.warnings?.length) {
          console.log(`[sources] ${source.type}: ${summary}`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(`[sources] ${source.type} failed: ${error}`);
        if (claimed) await finishSourceSync(source.type, { ok: false, error }).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}
