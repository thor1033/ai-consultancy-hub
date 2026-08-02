import { NextResponse } from "next/server";
import { runDueSchedules } from "@/lib/scheduler";
import { errorResponse } from "@/lib/apiError";

export const runtime = "nodejs";
export const maxDuration = 60;

// Runs all due scheduled automations. Meant to be hit by a cron (Vercel Cron or a
// system crontab) in deployments where the in-process ticker isn't reliable. If
// CRON_SECRET is set, the caller must present it as a bearer token; otherwise the
// endpoint is open (fine for local/dev behind the firewall).
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const match = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!match || match[1].trim() !== secret) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }
  try {
    return NextResponse.json(await runDueSchedules());
  } catch (err) {
    return errorResponse(err);
  }
}
