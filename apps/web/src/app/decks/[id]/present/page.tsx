import { notFound } from "next/navigation";
import { sessionCan } from "@/lib/sessionPrincipal";
import { visibleDeck } from "@/lib/decks/ops";
import { Presenter } from "./Presenter";

export const dynamic = "force-dynamic";

export default async function PresentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await sessionCan("agent:run");
  if (!principal) notFound();
  const deck = await visibleDeck(principal, id);
  if (!deck) notFound();
  return <Presenter initial={deck} />;
}
