import { getSql } from "./client";

// The clock's record of knowledge-source syncs (schema.sql: source_syncs).
// Pure storage, like collections.ts: what a sync does is @ai-hub/rag's, and
// when it runs is the web app's scheduler.

export interface SourceSyncRow {
  sourceType: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** null while the first sync is still running. */
  ok: boolean | null;
  summary: string;
  error: string | null;
}

/**
 * Claim the next sync of a source, if it is due.
 *
 * Due means: never synced, or the last one started at least `everyMinutes`
 * ago. The claim is one statement, so when several machines tick at once
 * exactly one gets a row back. A sync that died mid-way (the machine was
 * replaced) left started_at behind, and is claimed again by the same rule once
 * the interval has passed — there is no separate lock to go stale.
 */
export async function claimSourceSync(sourceType: string, everyMinutes: number): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    insert into source_syncs (source_type, started_at)
    values (${sourceType}, now())
    on conflict (source_type) do update set started_at = now()
     where source_syncs.started_at is null
        or source_syncs.started_at <= now() - make_interval(mins => ${everyMinutes})
    returning source_type
  `;
  return rows.length > 0;
}

/** Record how a claimed sync ended. */
export async function finishSourceSync(
  sourceType: string,
  outcome: { ok: true; summary: string } | { ok: false; error: string },
): Promise<void> {
  const sql = getSql();
  await sql`
    update source_syncs
       set finished_at = now(),
           ok          = ${outcome.ok},
           summary     = ${outcome.ok ? outcome.summary : ""},
           error       = ${outcome.ok ? null : outcome.error}
     where source_type = ${sourceType}
  `;
}

export async function listSourceSyncs(): Promise<SourceSyncRow[]> {
  const sql = getSql();
  return sql<SourceSyncRow[]>`
    select source_type as "sourceType", started_at as "startedAt", finished_at as "finishedAt",
           ok, summary, error
      from source_syncs
     order by source_type
  `;
}
