import { NextResponse } from "next/server";
import { runSkill } from "@/lib/runSkill";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const gate = await guard(req, "skill:run", `skill:${slug}`);
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.input !== "string" || b.input.trim() === "") {
    return NextResponse.json(
      { error: "`input` (non-empty string) is required." },
      { status: 400 },
    );
  }

  try {
    const out = await runSkill(slug, b.input, {
      retrieve: b.retrieve === true,
      retrieveK: typeof b.retrieveK === "number" ? b.retrieveK : undefined,
    });
    if ("notFound" in out) {
      return NextResponse.json({ error: "Skill not found." }, { status: 404 });
    }
    return NextResponse.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
