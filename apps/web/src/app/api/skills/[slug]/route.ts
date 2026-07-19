import { NextResponse } from "next/server";
import { getSkill } from "@ai-hub/db";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const gate = await guard(req, "skill:read", `skill:${slug}`);
  if (!gate.ok) return gate.response;
  try {
    const skill = await getSkill(slug);
    if (!skill) {
      return NextResponse.json({ error: "Skill not found." }, { status: 404 });
    }
    return NextResponse.json(skill);
  } catch (err) {
    return errorResponse(err);
  }
}
