/*
 * Talking back to Teams.
 *
 * Inbound is a webhook; outbound is a separate authenticated call to the Bot
 * Connector at the `serviceUrl` the activity arrived with. That asymmetry is
 * why `verifyInboundToken` binds the token to the serviceUrl: this file will
 * send a bot credential to whatever address it is handed.
 *
 * Everything here is best-effort by design. A reply that fails to post must not
 * fail the work it was reporting on — an approved mail that was sent, and whose
 * confirmation card did not render, is a much better outcome than the reverse.
 */

const LOGIN_BASE = process.env.TEAMS_LOGIN_BASE_URL ?? "https://login.microsoftonline.com";

/** Cached until shortly before expiry; every reply needs one. */
let cachedToken: { value: string; expiresAt: number } | null = null;

function botConfig() {
  const appId = process.env.TEAMS_APP_ID;
  const password = process.env.TEAMS_APP_PASSWORD;
  if (!appId || !password) return null;
  // A single-tenant bot signs in against its own tenant; the multi-tenant
  // default is the shared `botframework.com` directory.
  const tenant = process.env.TEAMS_TENANT_ID || "botframework.com";
  return { appId, password, tenant };
}

async function botToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const cfg = botConfig();
  if (!cfg) throw new Error("TEAMS_APP_ID / TEAMS_APP_PASSWORD are not set — the bot cannot reply.");

  const res = await fetch(`${LOGIN_BASE}/${cfg.tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.appId,
      client_secret: cfg.password,
      scope: "https://api.botframework.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string | number>;
  if (!res.ok) {
    throw new Error(`Bot sign-in failed (${res.status}): ${body.error_description ?? body.error ?? "unknown"}`);
  }
  cachedToken = {
    value: String(body.access_token),
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

async function connector(serviceUrl: string, path: string, method: "POST" | "PUT", activity: unknown) {
  const token = await botToken();
  const url = `${serviceUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(activity),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Bot Connector ${method} ${path} failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return (await res.json().catch(() => ({}))) as { id?: string };
}

export interface ThreadRef {
  serviceUrl: string;
  conversationId: string;
  /** The activity to reply under, so the answer threads instead of starting one. */
  replyToId?: string;
}

const adaptive = (card: unknown) => ({
  contentType: "application/vnd.microsoft.card.adaptive",
  content: card,
});

/** Post a plain message into the thread. Returns the new activity's id. */
export async function say(thread: ThreadRef, text: string): Promise<string | null> {
  try {
    const sent = await connector(
      thread.serviceUrl,
      `/v3/conversations/${encodeURIComponent(thread.conversationId)}/activities`,
      "POST",
      { type: "message", text, ...(thread.replyToId ? { replyToId: thread.replyToId } : {}) },
    );
    return sent.id ?? null;
  } catch {
    return null;
  }
}

/** Post an Adaptive Card into the thread. Returns the new activity's id. */
export async function showCard(thread: ThreadRef, card: unknown, fallback: string): Promise<string | null> {
  try {
    const sent = await connector(
      thread.serviceUrl,
      `/v3/conversations/${encodeURIComponent(thread.conversationId)}/activities`,
      "POST",
      {
        type: "message",
        text: fallback, // what a client that cannot render cards shows
        attachments: [adaptive(card)],
        ...(thread.replyToId ? { replyToId: thread.replyToId } : {}),
      },
    );
    return sent.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Replace a card that has already been posted.
 *
 * This is what removes the Approve and Reject buttons once a decision is made.
 * Without it the buttons stay live in everyone's client, and the second person
 * to press one gets "already decided" instead of seeing that it was.
 */
export async function replaceCard(
  thread: ThreadRef,
  activityId: string,
  card: unknown,
  fallback: string,
): Promise<boolean> {
  try {
    await connector(
      thread.serviceUrl,
      `/v3/conversations/${encodeURIComponent(thread.conversationId)}/activities/${encodeURIComponent(activityId)}`,
      "PUT",
      { type: "message", text: fallback, attachments: [adaptive(card)] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Who this Teams user actually is.
 *
 * The roster call, not Microsoft Graph: it needs no Graph permission, it is
 * scoped to the conversation the bot is already in, and it returns the work
 * address — which is the key `principals` is matched on.
 */
export async function member(
  thread: ThreadRef,
  userId: string,
): Promise<{ email?: string; name?: string } | null> {
  try {
    const token = await botToken();
    const url = `${thread.serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(
      thread.conversationId,
    )}/members/${encodeURIComponent(userId)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const m = (await res.json()) as { email?: string; userPrincipalName?: string; name?: string };
    return { email: m.email ?? m.userPrincipalName, name: m.name };
  } catch {
    return null;
  }
}
