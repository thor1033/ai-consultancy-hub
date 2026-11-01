import { NextResponse } from "next/server";
import { retrieveChunks } from "@ai-hub/rag";
import { knowledgeAccessFor } from "@ai-hub/authz";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";
import { outsideAccess } from "@/lib/sensitivity";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await guard(req, "rag:search");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.query !== "string" || b.query.trim() === "") {
    return NextResponse.json(
      { error: "`query` (non-empty string) is required." },
      { status: 400 },
    );
  }

  try {
    const k = typeof b.k === "number" ? b.k : 5;
    // A client outside the hub: nothing labelled confidential or special (lib/sensitivity.ts).
    const { access } = await outsideAccess(await knowledgeAccessFor(gate.principal));
    const chunks = await retrieveChunks(b.query, access, k);
    return NextResponse.json({ query: b.query, chunks });
  } catch (err) {
    return errorResponse(err);
  }
}
