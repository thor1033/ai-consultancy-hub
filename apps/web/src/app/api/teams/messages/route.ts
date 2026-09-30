import { NextResponse } from "next/server";
import { verifyInboundToken } from "@/lib/teams/auth";
import { handleActivity, type InboundActivity } from "@/lib/teams/handler";

/*
 * The bot's messaging endpoint — the hub's first inbound route.
 *
 * Everything else here starts with a person holding a credential: an OAuth
 * token, a hub_sk_… key, or the clock. This one is a public URL that Microsoft
 * POSTs to, so the whole of its trust comes from the token on the request
 * (lib/teams/auth.ts) and the identity resolved from the activity's sender
 * (lib/teams/identity.ts). Those are separate steps because they establish
 * different things: the token proves Microsoft sent it, not who typed.
 *
 * It answers 200 immediately and lets the work finish behind it. That is not a
 * shortcut — Teams retries an activity it does not get a quick answer to, and
 * retrying an approval would send the mail twice.
 */

// node, not edge: the agent run, the MCP SDKs and node:crypto all need it.
export const runtime = "nodejs";

export async function POST(req: Request) {
  let activity: InboundActivity;
  try {
    activity = (await req.json()) as InboundActivity;
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const verified = await verifyInboundToken(req.headers.get("authorization"), activity.serviceUrl);
  if (!verified.ok) {
    // 401 with no detail in the body: this endpoint is public, and a precise
    // reason tells whoever is probing it which part to fix. The reason is
    // logged instead, where an operator can read it.
    console.warn(`[teams] rejected an inbound activity: ${verified.error}`);
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let handled;
  try {
    handled = await handleActivity(activity);
  } catch (err) {
    console.error("[teams] handler failed", err);
    // Still 200. A 500 makes Teams retry, and a retried run is a second run.
    return NextResponse.json({ status: "error" }, { status: 200 });
  }

  // The background work is deliberately not awaited: the container is
  // long-running, and an agent turn takes minutes while Teams waits seconds.
  // Failures inside it report themselves into the thread.
  void handled.background?.catch((err) => console.error("[teams] background work failed", err));

  return NextResponse.json({ status: handled.kind }, { status: 200 });
}

/** A GET is how people check the endpoint is live; it must never do work. */
export async function GET() {
  return NextResponse.json({
    endpoint: "teams-messages",
    configured: Boolean(process.env.TEAMS_APP_ID && process.env.TEAMS_APP_PASSWORD),
  });
}
