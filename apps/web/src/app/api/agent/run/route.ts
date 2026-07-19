import { NextResponse } from "next/server";
import { runAgent, type ModelId } from "@ai-hub/agent";
import { connectMcpServers, sampleMcpConfig, type ConnectedMcp } from "@ai-hub/mcp";
import { guard } from "@/lib/authz";

// The Anthropic + MCP SDKs need the Node runtime (not edge). Agent turns can be slow.
export const runtime = "nodejs";
export const maxDuration = 60;

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

  // `mcp: "sample"` connects the bundled sample MCP server for this request so
  // Claude can call its tools. Real tailored MCP servers are configured per
  // client; this flag exists to demonstrate the tool-call loop.
  let mcp: ConnectedMcp | undefined;
  try {
    if (b.mcp === "sample") {
      mcp = await connectMcpServers([sampleMcpConfig()]);
    }

    const result = await runAgent({
      prompt: b.prompt,
      system: typeof b.system === "string" ? b.system : undefined,
      model: typeof b.model === "string" ? (b.model as ModelId) : undefined,
      effort: b.effort as "low" | "medium" | "high" | "max" | undefined,
      tools: mcp?.tools,
      toolExecutor: mcp?.execute,
      metadata: { source: "api/agent/run", mcp: b.mcp ?? null },
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await mcp?.close();
  }
}
