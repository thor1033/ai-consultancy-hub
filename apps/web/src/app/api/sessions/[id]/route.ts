import { NextResponse } from "next/server";
import { getSession } from "@ai-hub/db";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guard(req, "session:read");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  try {
    const session = await getSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    return NextResponse.json(session);
  } catch (err) {
    return errorResponse(err);
  }
}
