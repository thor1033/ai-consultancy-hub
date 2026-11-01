import { NextResponse } from "next/server";
import { exportPerson, recordAuthEvent } from "@ai-hub/db";
import { sessionPrincipal, standingAdmin } from "@/lib/sessionPrincipal";

export const dynamic = "force-dynamic";

/**
 * A person's data, as a JSON download (docs/retention.md, "A person's rights").
 *
 *   /settings/export                 your own
 *   /settings/export?principal=<id>  someone else's — admins only
 *
 * Everything the hub holds about them as a user: their runs' questions and
 * answers (as retention has left them), proposals, memories they wrote or that
 * are kept for them, schedules, decks, grants, credentials (names and
 * prefixes, never secrets) and their audit trail. Each export is itself on the
 * audit trail.
 */
export async function GET(req: Request) {
  const me = await sessionPrincipal();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const asked = new URL(req.url).searchParams.get("principal")?.trim();
  const subject = asked || me.id;
  if (subject !== me.id && !(await standingAdmin())) {
    return NextResponse.json({ error: "Only an admin can export someone else's data." }, { status: 403 });
  }
  const data = await exportPerson(subject);
  if (!data.person && subject !== me.id) return NextResponse.json({ error: "No such person." }, { status: 404 });
  await recordAuthEvent({
    event: "data.exported",
    source: "oauth",
    principalId: subject,
    actor: me.email ?? me.id,
    detail: { runs: data.runs.length, memories: data.memories.length, byAdmin: subject !== me.id },
  });
  const day = new Date().toISOString().slice(0, 10);
  const name = `hub-data-${subject.replace(/[^a-zA-Z0-9.@_-]+/g, "_")}-${day}.json`;
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      // A person's data is not something a shared cache should keep.
      "cache-control": "no-store",
    },
  });
}
