import type { Principal } from "@ai-hub/authz";
import { knowledgeAccessFor } from "@ai-hub/authz";
import { MODELS } from "@ai-hub/agent";
import type { Deck } from "@ai-hub/db";
import { chunksToContext, retrieveChunks } from "@ai-hub/rag";
import { runSession } from "@/lib/runSession";
import { SLIDE_SPEC, validateSlide, type SlideContent } from "./schema";

/*
 * The question box: a question from the room becomes one slide in the tray.
 *
 * One model call, no tool loop, on the fast model: a presenter waiting in
 * front of an audience needs an answer in seconds, not a research project.
 * Grounding comes from retrieval instead, done here and handed to the model
 * as context: the deck's collection, read AS THE PRESENTER, so a slide can
 * only quote what the person presenting may read. The run is recorded like
 * any other, so its cost shows up where costs are counted.
 */

const SYSTEM = `You write one presentation slide that answers a question asked by the audience during a live presentation by a management consultancy, Teqneo. It must look like the rest of a consultancy deck.

Rules:
- The title is an ACTION TITLE: the answer to the question in one sentence, with the number in it when there is one. Not a topic, not the question repeated.
- Choose the kind that shows the answer best. Numbers over time → trend; a total built from parts → waterfall; a comparison of a few items → bars with the one that matters highlighted; options against criteria → harvey; a plan → timeline or process; otherwise bullets or columns. Give charts a caption saying what is measured, and a unit.
- Set "kicker" to "Question from the room", and "takeaway" to the so-what in one line when there is one.
- Use the retrieved context when it answers the question, and list the documents you used in "sources" (they are printed on the slide). Never invent figures, dates, names or commitments. If the context does not answer it, say what is known, set "sticker" to "To be confirmed", and say what must be checked after the meeting.
- Fit the deck: match its language and do not repeat a slide it already has.
- Put what the presenter should say, and any caveat, in "notes". Start the notes with the question as asked.

${SLIDE_SPEC}

Reply with exactly one JSON object for the slide, in a \`\`\`json fenced block, and nothing else.`;

/** The first JSON object in a reply, fenced or not. */
export function parseDraftedSlide(reply: string): { slide: SlideContent } | { error: string } {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  if (!candidate.trim()) return { error: "The model did not write a slide." };
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return { error: "The model's slide was not valid JSON." };
  }
  return validateSlide(json);
}

function outline(deck: Deck, onScreen: string | null): string {
  return deck.slides
    .filter((s) => s.status === "live")
    .map((s, i) => {
      const head = String(s.title ?? s.quote ?? "").slice(0, 120);
      return `${i + 1}. [${s.kind}] ${head}${s.id === onScreen ? "   ← on screen now" : ""}`;
    })
    .join("\n");
}

export async function draftSlide(
  principal: Principal,
  deck: Deck,
  question: string,
): Promise<{ slide: SlideContent; sources: string[] } | { error: string }> {
  const q = question.trim();
  if (!q) return { error: "Type the question first." };
  if (q.length > 1000) return { error: "That question is too long; shorten it to what was asked." };

  // Best-effort grounding: a missing embedder or an empty index still gets a
  // slide, which will say what it could not confirm.
  let context: string | undefined;
  let sources: string[] = [];
  try {
    const chunks = await retrieveChunks(q, await knowledgeAccessFor(principal), 6, deck.collection ? { collection: deck.collection } : {});
    if (chunks.length) {
      context = chunksToContext(chunks);
      sources = [...new Set(chunks.map((c) => c.title).filter((t): t is string => Boolean(t)))];
    }
  } catch {
    /* retrieval unavailable — draft without it */
  }

  const current = deck.slides.find((s) => s.id === deck.position);
  const prompt =
    `Deck: "${deck.title}"\n\nSlides so far:\n${outline(deck, deck.position)}\n\n` +
    (current ? `The slide on screen now, as JSON:\n${JSON.stringify(current)}\n\n` : "") +
    `Question from the audience:\n${q}`;

  let reply: string;
  try {
    const { result } = await runSession({
      prompt,
      system: SYSTEM,
      context,
      model: MODELS.sonnet,
      effort: "low",
      maxIterations: 1,
      principalId: principal.id,
    });
    reply = result.text ?? "";
  } catch (err) {
    return { error: `The slide could not be drafted: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = parseDraftedSlide(reply);
  if ("error" in parsed) return parsed;
  const slide = parsed.slide;
  // The retrieval's titles are the record of what grounded it, whatever the
  // model chose to cite; merged rather than replaced.
  const merged = [...new Set([...(slide.sources ?? []), ...sources])].slice(0, 10);
  return { slide: { ...slide, ...(merged.length ? { sources: merged } : {}) }, sources };
}
