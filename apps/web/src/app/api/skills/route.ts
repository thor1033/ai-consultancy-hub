import { NextResponse } from "next/server";
import { listSkills, createSkill, type McpEntry } from "@ai-hub/db";
import { errorResponse, isUniqueViolation } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const gate = await guard(req, "skill:read");
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ skills: await listSkills() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  const gate = await guard(req, "skill:create");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  for (const field of ["slug", "name", "instructions"] as const) {
    if (typeof b[field] !== "string" || (b[field] as string).trim() === "") {
      return NextResponse.json(
        { error: `\`${field}\` (non-empty string) is required.` },
        { status: 400 },
      );
    }
  }

  try {
    const skill = await createSkill({
      slug: b.slug as string,
      name: b.name as string,
      description: typeof b.description === "string" ? b.description : undefined,
      instructions: b.instructions as string,
      model: typeof b.model === "string" ? b.model : undefined,
      effort: typeof b.effort === "string" ? b.effort : undefined,
      mcpServers: Array.isArray(b.mcpServers) ? (b.mcpServers as McpEntry[]) : undefined,
      baselineMinutes:
        typeof b.baselineMinutes === "number" ? b.baselineMinutes : undefined,
    });
    return NextResponse.json(skill, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: `A skill with slug "${b.slug}" already exists.` },
        { status: 409 },
      );
    }
    return errorResponse(err);
  }
}
