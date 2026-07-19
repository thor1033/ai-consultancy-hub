import { NextResponse } from "next/server";
import { ingestDocument, listDocuments } from "@ai-hub/rag";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const gate = await guard(req, "document:read");
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ documents: await listDocuments() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  const gate = await guard(req, "document:write");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.content !== "string" || b.content.trim() === "") {
    return NextResponse.json(
      { error: "`content` (non-empty string) is required." },
      { status: 400 },
    );
  }

  try {
    const result = await ingestDocument({
      content: b.content,
      title: typeof b.title === "string" ? b.title : undefined,
      source: typeof b.source === "string" ? b.source : undefined,
      metadata:
        typeof b.metadata === "object" && b.metadata !== null
          ? (b.metadata as Record<string, unknown>)
          : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
