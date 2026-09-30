/*
 * Sending one approved draft. The only code in the hub that sends mail.
 *
 * It lives here, in the web app, and not in the Microsoft 365 MCP server, which
 * is the whole point. An agent run is an autonomous tool loop: a send tool in
 * that server would be called with nobody watching. This function is reachable
 * only from the approval route, after `decideApproval` has recorded that a named,
 * enabled person said yes.
 *
 * Two boundaries hold it there, and both are enforced rather than described:
 *
 *   A SEPARATE CREDENTIAL. `M365_SEND_*` is its own app registration, the only
 *   one granted Mail.Send. The agent's registration (`M365_*`) has
 *   Mail.ReadWrite and cannot send at all.
 *
 *   A PROCESS BOUNDARY. `M365_SEND_*` is stripped from every MCP server's
 *   environment (WITHHELD_FROM_TOOL_SERVERS in @ai-hub/mcp), so the process
 *   running the model's tools does not hold the key — a send tool smuggled in
 *   there could not authenticate. The `microsoft365` server reports
 *   `sendCredentialVisible` from `m365_whoami` so a regression is visible.
 *
 * Unconfigured is a first-class outcome, not a crash. Until the second app
 * registration exists, an approved send fails with a sentence saying the draft
 * is in Outlook and needs a human — which is exactly what is true.
 */

const LOGIN_BASE = process.env.M365_LOGIN_BASE_URL ?? "https://login.microsoftonline.com";
const GRAPH_BASE = process.env.M365_GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0";

/** What the mailbox actually sent, recorded against the approval. */
export interface SentRecord {
  draftId: string;
  subject: string;
  to: string[];
  cc: string[];
  sentAt: string;
  /** True when the draft was edited after it was proposed — see below. */
  editedAfterProposal?: boolean;
}

export type SendOutcome = { ok: true; sent: SentRecord } | { ok: false; error: string };

type SendConfig =
  | { ready: true; tenantId: string; clientId: string; clientSecret: string; mailbox: string }
  | { ready: false; missing: string[] };

function sendConfig(): SendConfig {
  const values = {
    M365_SEND_TENANT_ID: process.env.M365_SEND_TENANT_ID,
    M365_SEND_CLIENT_ID: process.env.M365_SEND_CLIENT_ID,
    M365_SEND_CLIENT_SECRET: process.env.M365_SEND_CLIENT_SECRET,
    M365_MAILBOX: process.env.M365_MAILBOX,
  };
  const missing = Object.entries(values)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) return { ready: false, missing };
  return {
    ready: true,
    tenantId: values.M365_SEND_TENANT_ID as string,
    clientId: values.M365_SEND_CLIENT_ID as string,
    clientSecret: values.M365_SEND_CLIENT_SECRET as string,
    mailbox: values.M365_MAILBOX as string,
  };
}

/** Whether an approved send could be carried out at all. Cheap; no network. */
export function sendingConfigured(): boolean {
  return sendConfig().ready;
}

async function sendToken(cfg: { tenantId: string; clientId: string; clientSecret: string }): Promise<string> {
  const res = await fetch(`${LOGIN_BASE}/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    // AADSTS codes are the diagnosis — consent missing, wrong secret, wrong
    // tenant. Never flatten them to "auth failed".
    throw new Error(`Microsoft sign-in failed (${res.status}): ${body.error_description ?? body.error ?? "unknown"}`);
  }
  return body.access_token;
}

const address = (r: { emailAddress?: { name?: string; address?: string } }) =>
  r?.emailAddress?.address ?? "";

/**
 * Send the draft an approval points at.
 *
 * It sends by DRAFT ID, never by re-composing from the approval's stored
 * arguments, and that is deliberate: between proposal and approval a person may
 * have opened the draft in Outlook and fixed it. Sending the draft means their
 * edit is honoured. Reading it back first means the edit is also *recorded* —
 * `result` holds what actually went out, so an approval whose subject no longer
 * matches what was approved is visible afterwards instead of invisible.
 */
export async function sendApprovedDraft(action: {
  draftId?: unknown;
  subject?: unknown;
}): Promise<SendOutcome> {
  const draftId = typeof action.draftId === "string" ? action.draftId : "";
  if (!draftId) return { ok: false, error: "This approval has no draftId — there is nothing to send." };

  const cfg = sendConfig();
  if (!cfg.ready) {
    return {
      ok: false,
      error:
        `No sending credential is configured (${cfg.missing.join(", ")}), so nothing was sent. ` +
        "The draft is in the mailbox's Drafts folder and can be sent by hand from Outlook.",
    };
  }

  try {
    const token = await sendToken(cfg);
    const auth = { authorization: `Bearer ${token}` };
    const base = `${GRAPH_BASE}/users/${encodeURIComponent(cfg.mailbox)}/messages/${encodeURIComponent(draftId)}`;

    const readRes = await fetch(`${base}?$select=subject,toRecipients,ccRecipients,isDraft`, { headers: auth });
    const draft = (await readRes.json().catch(() => ({}))) as Record<string, never>;
    if (!readRes.ok) {
      const err = (draft as { error?: { code?: string; message?: string } }).error ?? {};
      return { ok: false, error: `Could not read the draft (${readRes.status} ${err.code ?? ""}): ${err.message ?? "request failed"}`.trim() };
    }
    // Sending something already sent would be a second copy in someone's inbox.
    if ((draft as { isDraft?: boolean }).isDraft === false) {
      return { ok: false, error: "That message is not a draft any more — it looks as though it has already been sent." };
    }

    const subject = (draft as { subject?: string }).subject ?? "";
    const to = ((draft as { toRecipients?: [] }).toRecipients ?? []).map(address).filter(Boolean);
    const cc = ((draft as { ccRecipients?: [] }).ccRecipients ?? []).map(address).filter(Boolean);

    const sendRes = await fetch(`${base}/send`, { method: "POST", headers: auth });
    if (!sendRes.ok) {
      const body = (await sendRes.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      const err = body.error ?? {};
      const hint =
        sendRes.status === 403
          ? " — the sending app registration needs the Mail.Send application permission, with admin consent granted"
          : "";
      return { ok: false, error: `Graph ${sendRes.status} ${err.code ?? ""}: ${err.message ?? "send failed"}${hint}`.trim() };
    }

    return {
      ok: true,
      sent: {
        draftId,
        subject,
        to,
        cc,
        sentAt: new Date().toISOString(),
        ...(typeof action.subject === "string" && action.subject !== subject
          ? { editedAfterProposal: true }
          : {}),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
