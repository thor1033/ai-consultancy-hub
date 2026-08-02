import { NextResponse } from "next/server";
import { getSession, createSkill, markSessionSkillified } from "@ai-hub/db";
import { distillSkill, serverMarkers, type SkillDraft } from "@/lib/skillify";
import { errorResponse, isUniqueViolation } from "@/lib/apiError";
import { guard } from "@/lib/authz";

// Distillation runs a full agent turn; give it room.
export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/sessions/:id/skillify
//   { dryRun: true }  → distill and return a draft to review (nothing persisted)
//   { dryRun: false, ...overrides } → create the versioned Skill from the draft
// Optional overrides (name, slug, description, instructions, baselineMinutes)
// let the reviewer correct the draft before saving.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guard(req, "skill:create");
  if (!gate.ok) return gate.response;
  const { id } = await params;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — defaults to a create with no overrides */
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const dryRun = b.dryRun === true;

  try {
    const session = await getSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    if (!dryRun && session.skillId) {
      return NextResponse.json(
        {
          error: "This session was already skillified.",
          skillSlug: session.skillSlug,
        },
        { status: 409 },
      );
    }

    // Distill, then let the reviewer's overrides win over the model's draft.
    const distilled = await distillSkill(session);
    const draft: SkillDraft = {
      name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : distilled.name,
      slug: typeof b.slug === "string" && b.slug.trim() ? b.slug.trim() : distilled.slug,
      description:
        typeof b.description === "string" ? b.description : distilled.description,
      instructions:
        typeof b.instructions === "string" && b.instructions.trim()
          ? b.instructions
          : distilled.instructions,
      baselineMinutes:
        typeof b.baselineMinutes === "number"
          ? b.baselineMinutes
          : distilled.baselineMinutes,
    };

    if (dryRun) {
      return NextResponse.json({ draft, servers: session.mcpServers });
    }

    if (!draft.instructions.trim()) {
      return NextResponse.json(
        { error: "Distillation produced no instructions; cannot create a Skill." },
        { status: 422 },
      );
    }

    const skill = await createSkill({
      slug: draft.slug,
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      model: session.model ?? undefined,
      mcpServers: serverMarkers(session.mcpServers),
      baselineMinutes: draft.baselineMinutes ?? undefined,
    });

    await markSessionSkillified(session.id, skill.id);
    return NextResponse.json({ skill, draft }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: "A skill with that slug already exists. Choose a different slug." },
        { status: 409 },
      );
    }
    return errorResponse(err);
  }
}
