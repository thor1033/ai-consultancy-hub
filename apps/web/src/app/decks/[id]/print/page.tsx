import { notFound } from "next/navigation";
import { Slide } from "@/components/slides/Slide";
import { sessionCan } from "@/lib/sessionPrincipal";
import { visibleDeck } from "@/lib/decks/ops";
import { PrintToolbar } from "./PrintToolbar";

export const dynamic = "force-dynamic";

/*
 * The deck as pages: every live slide at 1280×720, one per page, for the
 * browser's "Save as PDF". Exactly what was on screen, including the slides
 * added during the presentation; never the tray.
 */
export default async function PrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await sessionCan("agent:run");
  if (!principal) notFound();
  const deck = await visibleDeck(principal, id);
  if (!deck) notFound();
  const slides = deck.slides.filter((s) => s.status === "live");
  return (
    <div className="deck-print fixed inset-0 z-[60] overflow-auto bg-[#5b5852] px-6 pb-10">
      <PrintToolbar title={deck.title} count={slides.length} />
      {slides.map((s, i) => (
        <div key={s.id} className="deck-print-page mx-auto mb-6 w-[1280px] shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
          <Slide slide={s} deckTitle={deck.title} number={i + 1} total={slides.length} />
        </div>
      ))}
    </div>
  );
}
