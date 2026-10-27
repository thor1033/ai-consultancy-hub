import { NextResponse } from "next/server";
import { type ModelId } from "@ai-hub/agent";
import { runSession, isKnownServer } from "@/lib/runSession";
import { runAgentForPrincipal } from "@/lib/agentRuns";
import { guard } from "@/lib/authz";

// The Anthropic + MCP SDKs need the Node runtime (not edge). Agent turns can be slow.
export const runtime = "nodejs";
export const maxDuration = 60;

// Normalizes the requested MCP servers. Accepts a string[] of names in `servers`,
// or the legacy `mcp: "<name>"` single-flag form.
function requestedServers(b: Record<string, unknown>): string[] {
  if (Array.isArray(b.servers)) {
    return b.servers.filter((s): s is string => typeof s === "string");
  }
  if (typeof b.mcp === "string") return [b.mcp];
  return [];
}

export async function POST(req: Request) {
  const gate = await guard(req, "agent:run");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.prompt !== "string" || b.prompt.trim() === "") {
    return NextResponse.json(
      { error: "`prompt` (non-empty string) is required." },
      { status: 400 },
    );
  }

  // `agent` runs a standing agent: its instructions, its memory, its curated
  // knowledge, retrieved as the caller. Without this the route accepted an
  // agent id and silently ignored it, so every turn through the API was a bare
  // model call — the agent you built in the hub existed only inside /agents.
  if (typeof b.agent === "string" && b.agent.trim()) {
    const outcome = await runAgentForPrincipal({
      agentRef: b.agent.trim(),
      prompt: b.prompt,
      principal: gate.principal,
    });
    if (outcome.kind === "error") {
      return NextResponse.json({ error: outcome.message }, { status: 400 });
    }
    if (outcome.kind === "running") {
      // 202: the work is real and ongoing, and the caller has somewhere to go.
      return NextResponse.json(
        { runId: outcome.runId, status: "running", agent: outcome.agentName },
        { status: 202 },
      );
    }
    return NextResponse.json({
      runId: outcome.runId,
      status: "succeeded",
      output: outcome.output,
      toolsUsed: outcome.toolsUsed,
    });
  }

  const servers = requestedServers(b);
  const unknown = servers.filter((s) => !isKnownServer(s));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown MCP server(s): ${unknown.join(", ")}.` },
      { status: 400 },
    );
  }

  try {
    const { sessionId, servers: used, result } = await runSession({
      prompt: b.prompt,
      system: typeof b.system === "string" ? b.system : undefined,
      model: typeof b.model === "string" ? (b.model as ModelId) : undefined,
      effort: b.effort as "low" | "medium" | "high" | "max" | undefined,
      servers,
      principalId: gate.principal.id,
    });
    return NextResponse.json({ sessionId, servers: used, ...result });
  } catch (err) {
    // MCP connections are closed inside runSession; nothing to clean up here.
    const message = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
