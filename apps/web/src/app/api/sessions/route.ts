import { NextResponse } from "next/server";
import { listSessions } from "@ai-hub/db";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";

// Lists recent workbench sessions (the raw material for Skillification).
export async function GET(req: Request) {
  const gate = await guard(req, "session:read");
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ sessions: await listSessions() });
  } catch (err) {
    return errorResponse(err);
  }
}
