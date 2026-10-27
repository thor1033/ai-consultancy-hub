import { NextResponse, type NextRequest } from "next/server";
import { deckState } from "@/lib/decks/ops";
import { sessionPrincipal } from "@/lib/sessionPrincipal";

export const dynamic = "force-dynamic";

// What the deck views poll, about once a second: the version, and the whole
// deck only when it moved. A plain read against the database, so every Fly
// machine answers the same and nothing has to hold a connection open.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await sessionPrincipal();
  if (!principal) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  const raw = req.nextUrl.searchParams.get("since");
  const since = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const state = await deckState(principal, id, since);
  if (!state) return NextResponse.json({ error: "No such deck." }, { status: 404 });
  return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
}
