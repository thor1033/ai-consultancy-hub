import { NextResponse } from "next/server";
import { listSkillGrantPrincipals, addSkillGrant } from "@ai-hub/db";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const gate = await guard(req, "skill:grant", `skill:${slug}`);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ slug, principals: await listSkillGrantPrincipals(slug) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const gate = await guard(req, "skill:grant", `skill:${slug}`);
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const principalId = (body as Record<string, unknown>)?.principalId;
  if (typeof principalId !== "string" || principalId.trim() === "") {
    return NextResponse.json(
      { error: "`principalId` (non-empty string) is required." },
      { status: 400 },
    );
  }

  try {
    const ok = await addSkillGrant(slug, principalId);
    if (!ok) return NextResponse.json({ error: "Skill not found." }, { status: 404 });
    return NextResponse.json({ slug, principalId }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
