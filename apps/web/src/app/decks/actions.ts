"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Deck } from "@ai-hub/db";
import {
  acceptSlide,
  addSlide,
  createDeck,
  discardSlide,
  moveSlide,
  removeDeck,
  removeSlide,
  renameDeck,
  setPosition,
  setPresenting,
  updateSlide,
  visibleDeck,
  type Result,
} from "@/lib/decks/ops";
import { draftSlide } from "@/lib/decks/draft";
import { sessionCan, sessionPrincipal } from "@/lib/sessionPrincipal";

// The deck pages' verbs, as the signed-in person. Every rule — who may see a
// deck, what goes to the tray — is in lib/decks/ops.ts; these carry the
// identity across and hand the fresh deck back, so the page redraws at once
// instead of waiting for its next poll.

type Reply = { deck: Deck } | { error: string };

async function after<T>(id: string, res: Result<T>): Promise<Reply> {
  if ("error" in res) return { error: res.error };
  const principal = await sessionPrincipal();
  const deck = principal ? await visibleDeck(principal, id) : null;
  return deck ? { deck } : { error: "No such deck." };
}

async function who() {
  return sessionCan("agent:run");
}

export async function createDeckAction(title: string, collection: string): Promise<{ error: string }> {
  const principal = await who();
  if (!principal) return { error: "You are not permitted to make decks." };
  const res = await createDeck(principal, { title, collection: collection || null }, "person");
  if ("error" in res) return res;
  revalidatePath("/decks");
  redirect(`/decks/${res.value.id}`);
}

export async function renameDeckAction(id: string, title: string): Promise<Reply> {
  const p = await who();
  return p ? after(id, await renameDeck(p, id, title)) : { error: "Not permitted." };
}

export async function deleteDeckAction(id: string): Promise<{ error: string }> {
  const p = await who();
  if (!p) return { error: "Not permitted." };
  const res = await removeDeck(p, id);
  if ("error" in res) return res;
  revalidatePath("/decks");
  redirect("/decks");
}

/** A slide typed or pasted as JSON. Lands on the deck: a person put it there. */
export async function addSlideJsonAction(id: string, json: string, afterId: string | null): Promise<Reply> {
  const p = await who();
  if (!p) return { error: "Not permitted." };
  let slide: unknown;
  try {
    slide = JSON.parse(json);
  } catch {
    return { error: "That is not valid JSON." };
  }
  return after(id, await addSlide(p, id, slide, { after: afterId, by: "person" }));
}

export async function updateSlideJsonAction(id: string, slideId: string, json: string): Promise<Reply> {
  const p = await who();
  if (!p) return { error: "Not permitted." };
  let slide: unknown;
  try {
    slide = JSON.parse(json);
  } catch {
    return { error: "That is not valid JSON." };
  }
  return after(id, await updateSlide(p, id, slideId, slide, "person"));
}

export async function moveSlideAction(id: string, slideId: string, direction: "up" | "down"): Promise<Reply> {
  const p = await who();
  if (!p) return { error: "Not permitted." };
  const deck = await visibleDeck(p, id);
  if (!deck) return { error: "No such deck." };
  const live = deck.slides.filter((s) => s.status === "live");
  const i = live.findIndex((s) => s.id === slideId);
  if (i < 0) return { error: "That slide is not in the deck." };
  const target = direction === "up" ? i - 1 : i + 1;
  if (target < 0 || target >= live.length) return { deck };
  // "Up" means after the slide two places back, or first; "down", after the next one.
  const anchor = direction === "up" ? (target === 0 ? null : live[target - 1].id) : live[target].id;
  return after(id, await moveSlide(p, id, slideId, anchor, "person"));
}

export async function removeSlideAction(id: string, slideId: string): Promise<Reply> {
  const p = await who();
  return p ? after(id, await removeSlide(p, id, slideId, "person")) : { error: "Not permitted." };
}

export async function acceptSlideAction(id: string, slideId: string, show: boolean): Promise<Reply> {
  const p = await who();
  return p ? after(id, await acceptSlide(p, id, slideId, show)) : { error: "Not permitted." };
}

export async function discardSlideAction(id: string, slideId: string): Promise<Reply> {
  const p = await who();
  return p ? after(id, await discardSlide(p, id, slideId)) : { error: "Not permitted." };
}

export async function setPositionAction(id: string, slideId: string): Promise<{ ok: true } | { error: string }> {
  const p = await who();
  if (!p) return { error: "Not permitted." };
  const res = await setPosition(p, id, slideId);
  return "error" in res ? res : { ok: true };
}

export async function setPresentingAction(id: string, presenting: boolean): Promise<Reply> {
  const p = await who();
  return p ? after(id, await setPresenting(p, id, presenting)) : { error: "Not permitted." };
}

/**
 * The question box: draft a slide from a question and put it in the tray.
 * Always the tray, presenting or not — it was written by a model, and a
 * person decides whether it goes on screen.
 */
export async function askAction(id: string, question: string): Promise<Reply> {
  const p = await who();
  if (!p) return { error: "Not permitted." };
  const deck = await visibleDeck(p, id);
  if (!deck) return { error: "No such deck." };
  const drafted = await draftSlide(p, deck, question);
  if ("error" in drafted) return drafted;
  return after(id, await addSlide(p, id, drafted.slide, { by: "agent", tray: true, after: deck.position }));
}
