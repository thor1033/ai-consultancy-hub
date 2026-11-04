import { getAgent, listSkills, skillToSkillMd } from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";

/*
 * A skill as a SKILL.md, to download (docs/skill-import.md, "Export"). The
 * hub imports the standard and, with this, writes it back: a champion can
 * give a skill to another hub, another firm, or Claude Code directly.
 *
 * Same door as the skill's page: whoever may run agents may read a skill's
 * prompt there, so they may download it here. Nothing secret is in it — a
 * skill is a prompt, its blanks and its checks.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; skill: string }> }): Promise<Response> {
  if (!(await sessionCan("agent:run"))) return new Response("Sign in to download a skill.", { status: 401 });
  const { slug, skill: skillSlug } = await params;
  const agent = await getAgent(slug);
  if (!agent) return new Response("No such agent.", { status: 404 });
  const skill = (await listSkills(agent.id)).find((s) => s.slug === skillSlug);
  if (!skill) return new Response("No such skill.", { status: 404 });
  return new Response(skillToSkillMd(skill, { name: agent.name, slug: agent.slug }), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="SKILL.md"`,
    },
  });
}
