import { NextResponse } from "next/server";
import { roiSummary } from "@ai-hub/db";
import { valueRoi } from "@/lib/roi";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";

// The money-saved report: aggregate ROI across all skill runs, priced at the
// analyst hourly rate. This is the number directors can show upward (docs/02).
export async function GET(req: Request) {
  const gate = await guard(req, "roi:read");
  if (!gate.ok) return gate.response;
  try {
    const summary = await roiSummary();
    return NextResponse.json(valueRoi(summary));
  } catch (err) {
    return errorResponse(err);
  }
}
