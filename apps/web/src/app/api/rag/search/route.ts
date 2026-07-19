import { NextResponse } from "next/server";
import { retrieveChunks } from "@ai-hub/rag";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

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
    const chunks = await retrieveChunks(b.query, k);
    return NextResponse.json({ query: b.query, chunks });
  } catch (err) {
    return errorResponse(err);
  }
}
