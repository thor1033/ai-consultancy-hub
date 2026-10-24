import { getSql } from "./client";

/*
 * Decks — storage only (docs/decks.md).
 *
 * What a slide may contain, who may change a deck and when a change goes to
 * the presenter's tray are rules, and they live in apps/web/src/lib/decks,
 * next to the renderer and the tools that apply them. This file keeps rows
 * and enforces the one thing storage must: a write lands only on the version
 * it was computed from.
 */

/** A slide as stored: its content is whatever the slide schema allowed in. */
export interface StoredSlide {
  id: string;
  kind: string;
  status: "live" | "pending";
  /** A person in the hub's UI, or an agent through a tool or the question box. */
  by: "person" | "agent";
  createdAt: string;
  /** For a pending slide: where it should go when accepted. */
  after?: string | null;
  [field: string]: unknown;
}

export interface Deck {
  id: string;
  title: string;
  ownerPrincipalId: string | null;
  collection: string | null;
  slides: StoredSlide[];
  position: string | null;
  presenting: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `
  id, title, owner_principal_id as "ownerPrincipalId", collection, slides,
  position, presenting, version, created_at as "createdAt", updated_at as "updatedAt"
`;

export async function createDeck(input: {
  title: string;
  ownerPrincipalId: string | null;
  collection?: string | null;
  slides?: StoredSlide[];
}): Promise<Deck> {
  const sql = getSql();
  const [row] = await sql<Deck[]>`
    insert into decks (title, owner_principal_id, collection, slides)
    values (${input.title}, ${input.ownerPrincipalId}, ${input.collection ?? null},
            ${sql.json((input.slides ?? []) as unknown as Parameters<typeof sql.json>[0])})
    returning ${sql.unsafe(COLUMNS)}
  `;
  return row;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function getDeck(id: string): Promise<Deck | null> {
  if (!isUuid(id)) return null;
  const sql = getSql();
  const [row] = await sql<Deck[]>`select ${sql.unsafe(COLUMNS)} from decks where id = ${id}`;
  return row ?? null;
}

/** Just the version: what a live view polls, one indexed read. */
export async function deckVersion(id: string): Promise<number | null> {
  if (!isUuid(id)) return null;
  const sql = getSql();
  const [row] = await sql<{ version: number }[]>`select version from decks where id = ${id}`;
  return row?.version ?? null;
}

export async function listDecks(limit = 100): Promise<Deck[]> {
  const sql = getSql();
  return sql<Deck[]>`select ${sql.unsafe(COLUMNS)} from decks order by updated_at desc limit ${limit}`;
}

/**
 * Write a changed deck, but only over the version it was read at.
 *
 * Returns null when someone else wrote first; the caller re-reads and
 * re-applies. That is what lets an agent add a slide while the presenter
 * moves to the next one without either change overwriting the other.
 */
export async function saveDeck(deck: Deck, expectedVersion: number): Promise<Deck | null> {
  const sql = getSql();
  const [row] = await sql<Deck[]>`
    update decks set
      title      = ${deck.title},
      collection = ${deck.collection},
      slides     = ${sql.json(deck.slides as unknown as Parameters<typeof sql.json>[0])},
      position   = ${deck.position},
      presenting = ${deck.presenting},
      version    = version + 1,
      updated_at = now()
    where id = ${deck.id} and version = ${expectedVersion}
    returning ${sql.unsafe(COLUMNS)}
  `;
  return row ?? null;
}

export async function deleteDeck(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const sql = getSql();
  const rows = await sql`delete from decks where id = ${id}`;
  return rows.count > 0;
}
