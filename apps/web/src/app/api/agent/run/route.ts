import { NextResponse } from "next/server";
import { type ModelId } from "@ai-hub/agent";
import { runSession, isKnownServer } from "@/lib/runSession";
import { guard } from "@/lib/authz";

// The Anthropic + MCP SDKs need the Node runtime (not edge). Agent turns can be slow.
export const runtime = "nodejs";
export const maxDuration = 60;

// Normalizes the requested MCP servers. Accepts a string[] of names in `servers`,
// or the legacy `mcp: "sample"` single-flag form.
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
    });
    return NextResponse.json({ sessionId, servers: used, ...result });
  } catch (err) {
    // MCP connections are closed inside runSession; nothing to clean up here.
    const message = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
