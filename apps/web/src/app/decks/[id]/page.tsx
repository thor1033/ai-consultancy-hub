import { notFound } from "next/navigation";
import { authorize } from "@ai-hub/authz";
import { sessionCan } from "@/lib/sessionPrincipal";
import { visibleDeck } from "@/lib/decks/ops";
import { SLIDE_SPEC } from "@/lib/decks/schema";
import { DeckEditor } from "./DeckEditor";

export const dynamic = "force-dynamic";

export default async function DeckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await sessionCan("agent:run");
  if (!principal) notFound();
  const deck = await visibleDeck(principal, id);
  if (!deck) notFound();
  const canDelete = deck.ownerPrincipalId === principal.id || (await authorize(principal, "admin:manage"));
  return (
    <main className="mx-auto max-w-[90rem] px-5 py-7 lg:px-8">
      <DeckEditor initial={deck} canDelete={canDelete} spec={SLIDE_SPEC} />
    </main>
  );
}
