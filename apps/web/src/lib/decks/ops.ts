import { randomUUID } from "node:crypto";
import { authorize, knowledgeAccessFor, type Principal } from "@ai-hub/authz";
import {
  createDeck as storeCreate,
  deleteDeck as storeDelete,
  deckVersion,
  getDeck,
  listDecks,
  saveDeck,
  type Deck,
  type StoredSlide,
} from "@ai-hub/db";
import { collectionReadable } from "@ai-hub/rag";
import { validateSlide, type SlideContent } from "./schema";

/*
 * The rules of a deck (docs/decks.md).
 *
 * Who: anyone allowed to run agents may see and work on a deck, unless it is
 * about a collection they may not read — then it does not exist for them. A
 * deck about a client is as private as that client's documents. Deleting is
 * for the owner or an admin.
 *
 * When: while a deck is being presented, what is on the audience's screen is
 * the presenter's. An agent's new slide goes to the presenter's tray, and an
 * agent may not change, move or remove a live slide at all until the
 * presentation stops; it may revise its own pending ones. Outside a
 * presentation an agent edits the deck like a person would.
 */

export type Actor = "person" | "agent";
export type Result<T> = { ok: true; value: T } | { error: string };
const fail = <T>(error: string): Result<T> => ({ error });

/** The deck, if this principal may see it. Missing and forbidden read the same. */
export async function visibleDeck(principal: Principal, id: string): Promise<Deck | null> {
  if (!(await authorize(principal, "agent:run"))) return null;
  const deck = await getDeck(id);
  if (!deck) return null;
  if (deck.collection) {
    const access = await knowledgeAccessFor(principal);
    if (!collectionReadable(access, deck.collection)) return null;
  }
  return deck;
}

export async function visibleDecks(principal: Principal): Promise<Deck[]> {
  if (!(await authorize(principal, "agent:run"))) return [];
  const access = await knowledgeAccessFor(principal);
  return (await listDecks()).filter((d) => !d.collection || collectionReadable(access, d.collection));
}

const newId = () => randomUUID().slice(0, 8);

function stored(slide: SlideContent, status: StoredSlide["status"], by: Actor, after?: string | null): StoredSlide {
  return { ...slide, id: newId(), status, by, createdAt: new Date().toISOString(), ...(status === "pending" ? { after: after ?? null } : {}) };
}

const live = (d: Deck) => d.slides.filter((s) => s.status === "live");

export async function createDeck(
  principal: Principal,
  input: { title: string; collection?: string | null; slides?: unknown[] },
  by: Actor,
): Promise<Result<Deck>> {
  if (!(await authorize(principal, "agent:run"))) return fail("You are not permitted to make decks.");
  const title = input.title?.trim();
  if (!title) return fail("A deck needs a title.");
  if (title.length > 160) return fail("That title is too long for a deck.");
  const collection = input.collection?.trim() || null;
  if (collection) {
    // Naming a collection you cannot read would make a deck you cannot open.
    const access = await knowledgeAccessFor(principal);
    if (!collectionReadable(access, collection)) return fail(`You may not read the collection "${collection}".`);
  }
  const slides: StoredSlide[] = [];
  const raw = input.slides?.length ? input.slides : [{ kind: "title", title }];
  for (const [i, s] of raw.entries()) {
    const v = validateSlide(s);
    if ("error" in v) return fail(`Slide ${i + 1}: ${v.error}`);
    slides.push(stored(v.slide, "live", by));
  }
  if (slides.length > 80) return fail("A deck holds at most 80 slides.");
  return { ok: true, value: await storeCreate({ title, ownerPrincipalId: principal.id, collection, slides }) };
}

/**
 * Read, change, write — again if someone else wrote in between. `change`
 * is pure: it gets the latest deck and returns the next one or a refusal.
 */
async function mutate<T>(
  principal: Principal,
  id: string,
  change: (d: Deck) => { deck: Deck; value: T } | { error: string } | { unchanged: true; value: T },
): Promise<Result<T>> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const deck = await visibleDeck(principal, id);
    if (!deck) return fail("No such deck.");
    const next = change(structuredClone(deck));
    if ("error" in next) return fail(next.error);
    // Nothing to write: no version bump, so no view redraws for nothing.
    if ("unchanged" in next) return { ok: true, value: next.value };
    const saved = await saveDeck(next.deck, deck.version);
    if (saved) return { ok: true, value: next.value };
  }
  return fail("The deck kept changing while this was being saved; try again.");
}

function insertAfter(slides: StoredSlide[], slide: StoredSlide, after: string | null | undefined): StoredSlide[] {
  if (!after) return [...slides, slide];
  const i = slides.findIndex((s) => s.id === after);
  return i < 0 ? [...slides, slide] : [...slides.slice(0, i + 1), slide, ...slides.slice(i + 1)];
}

export interface Placed {
  slide: StoredSlide;
  /** Where it went: on the deck, or into the presenter's tray. */
  placed: "deck" | "tray";
}

/** Add a slide. An agent's slide during a presentation goes to the tray. */
export async function addSlide(
  principal: Principal,
  id: string,
  input: unknown,
  opts: { after?: string | null; by: Actor; tray?: boolean },
): Promise<Result<Placed>> {
  const v = validateSlide(input);
  if ("error" in v) return fail(v.error);
  return mutate<Placed>(principal, id, (d) => {
    if (d.slides.length >= 80) return { error: "A deck holds at most 80 slides." };
    if (opts.after && !d.slides.some((s) => s.id === opts.after)) return { error: `No slide ${opts.after} in this deck.` };
    const toTray = opts.tray === true || (opts.by === "agent" && d.presenting);
    const slide = stored(v.slide, toTray ? "pending" : "live", opts.by, toTray ? (opts.after ?? d.position) : null);
    d.slides = toTray ? [...d.slides, slide] : insertAfter(d.slides, slide, opts.after);
    return { deck: d, value: { slide, placed: toTray ? "tray" : "deck" } };
  });
}

/** Replace a slide's content. An agent may not touch a live slide mid-presentation. */
export async function updateSlide(principal: Principal, id: string, slideId: string, input: unknown, by: Actor): Promise<Result<StoredSlide>> {
  const v = validateSlide(input);
  if ("error" in v) return fail(v.error);
  return mutate<StoredSlide>(principal, id, (d) => {
    const i = d.slides.findIndex((s) => s.id === slideId);
    if (i < 0) return { error: `No slide ${slideId} in this deck.` };
    const old = d.slides[i];
    if (by === "agent" && d.presenting && old.status === "live") {
      return { error: "This deck is being presented, so its live slides are the presenter's. Add a new slide instead; it goes to the presenter's tray." };
    }
    const next: StoredSlide = { ...v.slide, id: old.id, status: old.status, by, createdAt: old.createdAt, ...(old.status === "pending" ? { after: old.after ?? null } : {}) };
    d.slides[i] = next;
    return { deck: d, value: next };
  });
}

export async function moveSlide(principal: Principal, id: string, slideId: string, after: string | null, by: Actor): Promise<Result<null>> {
  return mutate<null>(principal, id, (d) => {
    if (by === "agent" && d.presenting) return { error: "This deck is being presented; the order is the presenter's until it stops." };
    const slide = d.slides.find((s) => s.id === slideId);
    if (!slide) return { error: `No slide ${slideId} in this deck.` };
    if (after === slideId) return { deck: d, value: null };
    if (after && !d.slides.some((s) => s.id === after)) return { error: `No slide ${after} in this deck.` };
    const rest = d.slides.filter((s) => s.id !== slideId);
    d.slides = after ? insertAfter(rest, slide, after) : [slide, ...rest];
    return { deck: d, value: null };
  });
}

export async function removeSlide(principal: Principal, id: string, slideId: string, by: Actor): Promise<Result<null>> {
  return mutate<null>(principal, id, (d) => {
    const slide = d.slides.find((s) => s.id === slideId);
    if (!slide) return { error: `No slide ${slideId} in this deck.` };
    if (by === "agent" && d.presenting && slide.status === "live") {
      return { error: "This deck is being presented; its live slides are the presenter's until it stops." };
    }
    if (slide.status === "live" && live(d).length <= 1) return { error: "A deck keeps at least one slide." };
    d.slides = d.slides.filter((s) => s.id !== slideId);
    if (d.position === slideId) d.position = live(d)[0]?.id ?? null;
    return { deck: d, value: null };
  });
}

/**
 * Take a slide out of the tray. `show` also puts it on screen now: it goes
 * right after the current slide and becomes the current slide.
 */
export async function acceptSlide(principal: Principal, id: string, slideId: string, show: boolean): Promise<Result<StoredSlide>> {
  return mutate<StoredSlide>(principal, id, (d) => {
    const slide = d.slides.find((s) => s.id === slideId);
    if (!slide || slide.status !== "pending") return { error: "That slide is no longer in the tray." };
    const rest = d.slides.filter((s) => s.id !== slideId);
    const anchor = show ? d.position : (slide.after ?? d.position);
    const placed: StoredSlide = { ...slide, status: "live" };
    delete placed.after;
    d.slides = insertAfter(rest, placed, anchor && rest.some((s) => s.id === anchor && s.status === "live") ? anchor : null);
    if (show) d.position = placed.id;
    return { deck: d, value: placed };
  });
}

export async function discardSlide(principal: Principal, id: string, slideId: string): Promise<Result<null>> {
  return mutate<null>(principal, id, (d) => {
    const slide = d.slides.find((s) => s.id === slideId);
    if (!slide || slide.status !== "pending") return { error: "That slide is no longer in the tray." };
    d.slides = d.slides.filter((s) => s.id !== slideId);
    return { deck: d, value: null };
  });
}

/** Where the presentation is. Only a live slide can be on screen. */
export async function setPosition(principal: Principal, id: string, slideId: string): Promise<Result<null>> {
  return mutate<null>(principal, id, (d) => {
    if (!d.slides.some((s) => s.id === slideId && s.status === "live")) return { error: "That slide is not in the deck." };
    if (d.position === slideId) return { unchanged: true, value: null };
    d.position = slideId;
    return { deck: d, value: null };
  });
}

export async function setPresenting(principal: Principal, id: string, presenting: boolean): Promise<Result<null>> {
  return mutate<null>(principal, id, (d) => {
    d.presenting = presenting;
    if (presenting && !d.slides.some((s) => s.id === d.position && s.status === "live")) d.position = live(d)[0]?.id ?? null;
    return { deck: d, value: null };
  });
}

export async function renameDeck(principal: Principal, id: string, title: string): Promise<Result<null>> {
  const t = title.trim();
  if (!t || t.length > 160) return fail("A deck needs a title of at most 160 characters.");
  return mutate<null>(principal, id, (d) => {
    d.title = t;
    return { deck: d, value: null };
  });
}

export async function removeDeck(principal: Principal, id: string): Promise<Result<null>> {
  const deck = await visibleDeck(principal, id);
  if (!deck) return fail("No such deck.");
  if (deck.ownerPrincipalId !== principal.id && !(await authorize(principal, "admin:manage"))) {
    return fail("Only the person who made this deck, or an admin, can delete it.");
  }
  await storeDelete(id);
  return { ok: true, value: null };
}

/**
 * What a live view polls: the version, and the whole deck when it moved.
 * A view that may no longer see the deck gets nothing, the same as missing.
 */
export async function deckState(principal: Principal, id: string, since: number | null): Promise<{ version: number; deck?: Deck } | null> {
  const version = await deckVersion(id);
  if (version === null) return null;
  if (since !== null && since === version) return { version };
  const deck = await visibleDeck(principal, id);
  return deck ? { version: deck.version, deck } : null;
}

/** A deck as an agent reads it: slide ids, order, status, content. */
export function describeDeck(deck: Deck, url?: string) {
  return {
    deck: deck.id,
    title: deck.title,
    collection: deck.collection,
    presenting: deck.presenting,
    onScreen: deck.position,
    ...(url ? { url } : {}),
    slides: deck.slides.map((s, i) => ({ n: i + 1, ...s })),
  };
}
