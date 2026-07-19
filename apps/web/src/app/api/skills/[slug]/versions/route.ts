import { NextResponse } from "next/server";
import { addSkillVersion, type McpEntry } from "@ai-hub/db";
import { errorResponse } from "@/lib/apiError";
import { guard } from "@/lib/authz";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const gate = await guard(req, "skill:write", `skill:${slug}`);
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.instructions !== "string" || b.instructions.trim() === "") {
    return NextResponse.json(
      { error: "`instructions` (non-empty string) is required." },
      { status: 400 },
    );
  }

  try {
    const version = await addSkillVersion(slug, {
      instructions: b.instructions,
      model: typeof b.model === "string" ? b.model : undefined,
      effort: typeof b.effort === "string" ? b.effort : undefined,
      mcpServers: Array.isArray(b.mcpServers) ? (b.mcpServers as McpEntry[]) : undefined,
      baselineMinutes:
        typeof b.baselineMinutes === "number" ? b.baselineMinutes : undefined,
    });
    if (!version) {
      return NextResponse.json({ error: "Skill not found." }, { status: 404 });
    }
    return NextResponse.json(version, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
