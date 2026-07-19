import { NextResponse } from "next/server";

// Liveness/readiness probe for the hub. Kept dependency-free so it stays green
// even before the agent runtime, database, and MCP layers are wired up.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "ai-hub-web",
    time: new Date().toISOString(),
  });
}
