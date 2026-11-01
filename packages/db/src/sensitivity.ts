import { getSql } from "./client";

// Sensitivity labels and the read log (docs/sensitivity.md).
//
// Storage only. What a label does — to a run's memory, transcript and trace,
// and to what leaves the hub — is decided in apps/web (lib/sensitivity.ts),
// next to the run it governs.

export type Sensitivity = "internal" | "confidential" | "special";
export const SENSITIVITIES: readonly Sensitivity[] = ["internal", "confidential", "special"];

export const isSensitivity = (v: unknown): v is Sensitivity => typeof v === "string" && (SENSITIVITIES as readonly string[]).includes(v);

const RANK: Record<Sensitivity, number> = { internal: 0, confidential: 1, special: 2 };

/** The highest of these labels; internal for none. */
export function highestSensitivity(labels: Iterable<Sensitivity | null | undefined>): Sensitivity {
  let top: Sensitivity = "internal";
  for (const l of labels) if (l && RANK[l] > RANK[top]) top = l;
  return top;
}

/** At least this label: `atLeast("special", "confidential")` is true. */
export const atLeast = (label: Sensitivity, floor: Sensitivity): boolean => RANK[label] >= RANK[floor];

/** Every collection labelled above internal, by name. Unlabelled ones are internal. */
export async function collectionSensitivities(): Promise<Map<string, Sensitivity>> {
  const sql = getSql();
  const rows = await sql<{ name: string; sensitivity: Sensitivity }[]>`
    select name, sensitivity from collections where sensitivity <> 'internal'
  `;
  return new Map(rows.map((r) => [r.name, r.sensitivity]));
}

/** Every connection labelled above internal, by name. */
export async function serverSensitivities(): Promise<Map<string, Sensitivity>> {
  const sql = getSql();
  const rows = await sql<{ name: string; sensitivity: Sensitivity }[]>`
    select name, sensitivity from mcp_servers where sensitivity <> 'internal'
  `;
  return new Map(rows.map((r) => [r.name, r.sensitivity]));
}

/**
 * The collections whose material may not leave the hub: confidential and
 * special. The hub's MCP server and local agents leave them out.
 */
export async function collectionsKeptInside(): Promise<string[]> {
  return [...(await collectionSensitivities()).keys()];
}

/**
 * Label a collection. Creates its row if nobody classified it yet, keeping the
 * visibility it had by default — a label is not a change of who may read it.
 * A confidential or special collection that is open is refused: a label that
 * says "keep it inside" on a drawer everyone may open is a contradiction an
 * admin should resolve, not one the hub should pick a side of.
 */
export async function setCollectionSensitivity(
  name: string,
  sensitivity: Sensitivity,
  defaultVisibility: "open" | "restricted",
): Promise<{ ok: true } | { error: string }> {
  if (!isSensitivity(sensitivity)) return { error: `"${String(sensitivity)}" is not a label.` };
  const sql = getSql();
  const [current] = await sql<{ visibility: string }[]>`select visibility from collections where name = ${name}`;
  const visibility = current?.visibility ?? defaultVisibility;
  if (sensitivity !== "internal" && visibility === "open") {
    return { error: `"${name}" is open to everyone signed in. Restrict it first, then label it ${sensitivity}.` };
  }
  await sql`
    insert into collections (name, visibility, sensitivity)
    values (${name}, ${visibility}, ${sensitivity})
    on conflict (name) do update set sensitivity = excluded.sensitivity, updated_at = now()
  `;
  return { ok: true };
}

/** Label a connection (any server: bundled, declared or added on the page). */
export async function setServerSensitivity(name: string, sensitivity: Sensitivity): Promise<{ ok: true } | { error: string }> {
  if (!isSensitivity(sensitivity)) return { error: `"${String(sensitivity)}" is not a label.` };
  const sql = getSql();
  await sql`
    insert into mcp_servers (name, sensitivity)
    values (${name}, ${sensitivity})
    on conflict (name) do update set sensitivity = excluded.sensitivity, updated_at = now()
  `;
  return { ok: true };
}

/** The highest label a run touched, recorded on its row once known. Only ever raises. */
export async function setRunSensitivity(runId: string, sensitivity: Sensitivity): Promise<void> {
  if (sensitivity === "internal") return;
  const sql = getSql();
  await sql`
    update agent_sessions set sensitivity = ${sensitivity}
     where id = ${runId}
       and (sensitivity = 'internal' or (sensitivity = 'confidential' and ${sensitivity} = 'special'))
  `;
}

/**
 * The highest label among a person's own runs — the earlier turns of a
 * conversation they are continuing. Runs that are not theirs count for
 * nothing, so a client cannot borrow another person's run to change anything.
 */
export async function highestRunSensitivity(runIds: string[], principalId: string): Promise<Sensitivity> {
  const ids = [...new Set(runIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (!ids.length) return "internal";
  const sql = getSql();
  const rows = await sql<{ sensitivity: Sensitivity }[]>`
    select sensitivity from agent_sessions
     where id = any(${ids}::uuid[]) and principal_id = ${principalId} and sensitivity <> 'internal'`;
  return highestSensitivity(rows.map((r) => r.sensitivity));
}

/** A run's label; internal for an unknown run. */
export async function runSensitivity(runId: string): Promise<Sensitivity> {
  const sql = getSql();
  const [row] = await sql<{ sensitivity: Sensitivity }[]>`select sensitivity from agent_sessions where id = ${runId}`;
  return row?.sensitivity ?? "internal";
}

// --- the read log -------------------------------------------------------------

export type ReadDoor = "run" | "chat" | "mcp" | "page";

export interface KnowledgeRead {
  /** The collection the passage or document is filed in; null (unfiled) is never logged. */
  collection: string | null;
  documentId?: string | null;
}

/**
 * Record who read confidential or special material, and through which door.
 * Only those labels are logged: logging every read of the lunch menu would
 * bury the reads that matter. Several passages of one document read in one
 * go are one read. Never throws — a log that failed must not fail the read it
 * records, and it says so on stderr instead.
 */
export async function recordKnowledgeReads(input: {
  principalId: string | null;
  door: ReadDoor;
  reads: KnowledgeRead[];
  runId?: string | null;
}): Promise<number> {
  try {
    const labelled = await collectionSensitivities();
    const seen = new Set<string>();
    const rows: { principal_id: string | null; door: ReadDoor; collection: string; sensitivity: Sensitivity; document_id: string | null; run_id: string | null }[] = [];
    for (const r of input.reads) {
      const label = r.collection ? labelled.get(r.collection) : undefined;
      if (!r.collection || !label) continue;
      const key = `${r.collection}\u0000${r.documentId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        principal_id: input.principalId,
        door: input.door,
        collection: r.collection,
        sensitivity: label,
        document_id: r.documentId ?? null,
        run_id: input.runId ?? null,
      });
    }
    if (!rows.length) return 0;
    const sql = getSql();
    await sql`insert into knowledge_reads ${sql(rows)}`;
    return rows.length;
  } catch (err) {
    console.error(`[read-log] not recorded: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export interface KnowledgeReadRow {
  id: string;
  at: string;
  principalId: string | null;
  /** Their name or email, for the page; null once they are erased or unknown. */
  who: string | null;
  door: ReadDoor;
  collection: string;
  sensitivity: Sensitivity;
  documentId: string | null;
  /** The document's title, while it exists. */
  document: string | null;
  runId: string | null;
}

/** The newest reads, optionally of one collection or by one person. Admin-only at the call site. */
export async function listKnowledgeReads(filter: { collection?: string; principalId?: string; limit?: number } = {}): Promise<KnowledgeReadRow[]> {
  const sql = getSql();
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  return sql<KnowledgeReadRow[]>`
    select r.id, r.at, r.principal_id as "principalId",
           coalesce(nullif(p.display_name, ''), p.email) as who,
           r.door, r.collection, r.sensitivity,
           r.document_id as "documentId", d.title as document, r.run_id as "runId"
      from knowledge_reads r
      left join principals p on p.id = r.principal_id
      left join documents d on d.id = r.document_id
     where ${filter.collection ? sql`r.collection = ${filter.collection}` : sql`true`}
       and ${filter.principalId ? sql`r.principal_id = ${filter.principalId}` : sql`true`}
     order by r.at desc
     limit ${limit}
  `;
}
