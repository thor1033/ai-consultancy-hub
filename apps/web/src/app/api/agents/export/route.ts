import { authenticate, authorize } from "@ai-hub/authz";
import { getAgent, listAgents, listSkills, runsLocally } from "@ai-hub/db";
import { wwwAuthenticate } from "@/lib/authz";
import { appBaseUrl } from "@/lib/baseUrl";
import { renderAgentFiles, localAgentName, type LocalFile } from "@/lib/localAgents";

/*
 * The agents placed "local" or "both", as the files Claude Code reads.
 *
 * Fetched by scripts/sync-hub-agents.mjs from a SessionStart hook. Same rule as
 * the per-agent endpoint: the caller must be allowed to run agents, and a
 * credential bound to one agent exports that agent alone. Nothing secret is in
 * the response — the files point at /api/mcp/agents/<slug>, which re-checks
 * everything on every call.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const principal = await authenticate(request.headers);
  if (!principal) {
    return Response.json(
      { error: "Unauthorized: missing or invalid bearer token." },
      { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate() } },
    );
  }
  if (!(await authorize(principal, "agent:run"))) {
    return Response.json({ error: "You are not permitted to run agents." }, { status: 403 });
  }

  const baseUrl = appBaseUrl(request.headers) ?? new URL(request.url).origin;

  // A bound credential sees its own agent only, resolved by id or slug the same
  // way every other binding is.
  const bound = principal.agentId ? await getAgent(principal.agentId) : null;
  const summaries = (await listAgents()).filter(
    (a) =>
      a.enabled &&
      runsLocally(a.placement) &&
      (!principal.agentId || (bound !== null && a.id === bound.id)),
  );

  const files: LocalFile[] = [];
  const agents: { slug: string; name: string; placement: string; subAgent: string }[] = [];
  for (const summary of summaries) {
    const agent = await getAgent(summary.id);
    if (!agent) continue;
    const skills = await listSkills(agent.id);
    files.push(...renderAgentFiles(agent, skills, baseUrl));
    agents.push({
      slug: agent.slug,
      name: agent.name,
      placement: agent.placement,
      subAgent: localAgentName(agent.slug),
    });
  }

  return Response.json(
    { hub: baseUrl, generatedAt: new Date().toISOString(), agents, files },
    { headers: { "Cache-Control": "no-store" } },
  );
}
