// Microsoft 365 MCP server — the secretary agent's mailbox and calendar.
//
// READ-ONLY, deliberately and completely. There is no tool here that sends,
// replies, accepts, declines, creates or deletes anything. An agent that can
// read your inbox on demand is useful the day it ships; an agent that can send
// from your address is a mistake you cannot take back, and it should arrive
// behind an approval gate rather than as a side effect of wiring up mail.
// Keep that property when extending this file: drafting belongs in a later
// increment, with a human confirming before anything leaves the tenant.
//
// AUTH is app-only (OAuth 2.0 client credentials): a confidential app
// registration with Application permissions Mail.Read + Calendars.Read and
// admin consent granted. There is no browser dance and no refresh token to
// rotate, which is what an unattended agent needs. The cost is that Application
// permissions span EVERY mailbox in the tenant, so scope this registration to
// the secretary's mailbox alone with an Application Access Policy:
//
//   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId \
//     secretary@yourdomain -AccessRight RestrictAccess
//
// Without that policy the credential in M365_CLIENT_SECRET reads the whole
// organisation's mail. See docs/secretary-agent.md.
//
// Like servers/memory/server.mjs this runs as a bare `node server.mjs` child
// process, so it uses native fetch and imports nothing from @ai-hub/*, whose
// TypeScript sources only a bundler resolves.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TENANT_ID = process.env.M365_TENANT_ID;
const CLIENT_ID = process.env.M365_CLIENT_ID;
const CLIENT_SECRET = process.env.M365_CLIENT_SECRET;
const MAILBOX = process.env.M365_MAILBOX;

// Overridable so verify-m365.mjs can point the whole server at a local fixture
// and exercise every tool without a tenant. Never set these in production.
const GRAPH_BASE = process.env.M365_GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0";
const LOGIN_BASE = process.env.M365_LOGIN_BASE_URL ?? "https://login.microsoftonline.com";

// The timezone Graph renders event times in. Outlook accepts Windows or IANA names.
const TIMEZONE = process.env.M365_TIMEZONE ?? "UTC";

// Fail closed and loudly on stderr: stdout is the JSON-RPC channel, so a message
// written there corrupts the protocol rather than reaching anyone.
const missing = [
  ["M365_TENANT_ID", TENANT_ID],
  ["M365_CLIENT_ID", CLIENT_ID],
  ["M365_CLIENT_SECRET", CLIENT_SECRET],
  ["M365_MAILBOX", MAILBOX],
].filter(([, v]) => !v).map(([k]) => k);

if (missing.length > 0) {
  console.error(`[microsoft365] not configured — missing ${missing.join(", ")}. Refusing to start.`);
  process.exit(1);
}

// ── token ────────────────────────────────────────────────────────────────────
// Cached until shortly before expiry. The process is per-run and short-lived, so
// this mostly saves the second and third tool call in one conversation.
let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch(`${LOGIN_BASE}/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // AADSTS codes are the whole diagnosis (consent missing, bad secret, wrong
    // tenant), so pass them through rather than flattening to "auth failed".
    throw new Error(
      `Microsoft sign-in failed (${res.status}): ${body.error_description ?? body.error ?? "unknown error"}`,
    );
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

// ── Graph ────────────────────────────────────────────────────────────────────
async function graph(path, search = {}) {
  const token = await accessToken();
  const url = new URL(`${GRAPH_BASE}/users/${encodeURIComponent(MAILBOX)}${path}`);
  for (const [k, v] of Object.entries(search)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      // Plain-text bodies instead of Outlook's HTML: the model reads these, and
      // a marketing email's HTML is thousands of tokens of nothing.
      prefer: `outlook.timezone="${TIMEZONE}", outlook.body-content-type="text"`,
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body.error ?? {};
    throw new Error(`Graph ${res.status} ${err.code ?? ""}: ${err.message ?? "request failed"}`.trim());
  }
  return body;
}

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failed = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

/** Tool bodies differ; their failure mode does not. */
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// Long bodies are truncated rather than dropped: the agent needs the gist and
// the fact that there is more, not the whole newsletter.
const BODY_LIMIT = 4000;
function bodyText(message) {
  const raw = message.body?.content ?? message.bodyPreview ?? "";
  const plain =
    message.body?.contentType === "html"
      ? raw.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
      : raw;
  const tidy = plain.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return tidy.length > BODY_LIMIT
    ? `${tidy.slice(0, BODY_LIMIT)}\n\n…[truncated, ${tidy.length - BODY_LIMIT} more characters]`
    : tidy;
}

const person = (r) => (r?.emailAddress ? `${r.emailAddress.name ?? ""} <${r.emailAddress.address}>`.trim() : null);

const summariseMessage = (m) => ({
  messageId: m.id,
  from: person(m.from) ?? person(m.sender),
  subject: m.subject,
  received: m.receivedDateTime,
  unread: m.isRead === false,
  hasAttachments: m.hasAttachments ?? false,
  preview: m.bodyPreview,
});

const summariseEvent = (e) => ({
  eventId: e.id,
  subject: e.subject,
  start: e.start?.dateTime ?? e.start,
  end: e.end?.dateTime ?? e.end,
  timezone: e.start?.timeZone,
  allDay: e.isAllDay ?? false,
  organiser: person(e.organizer),
  location: e.location?.displayName || null,
  online: e.onlineMeeting?.joinUrl ?? null,
  status: e.showAs,
  cancelled: e.isCancelled ?? false,
});

// ── server ───────────────────────────────────────────────────────────────────
const server = new McpServer(
  { name: "microsoft365", version: "0.1.0" },
  {
    instructions:
      `Read-only access to the mailbox and calendar of ${MAILBOX}. Use ` +
      "m365_calendar_list for what is coming up, m365_mail_list to see what has " +
      "arrived, and the _get tools when a summary is not enough and you need the " +
      "full body. You cannot send, reply, accept, decline or change anything from " +
      "here — when someone asks for that, draft the text in your answer and say it " +
      "still needs to be sent by hand.",
  },
);

server.registerTool(
  "m365_whoami",
  {
    description:
      "Confirm which mailbox this agent is reading, and that the Microsoft 365 connection works. Use it when a mail or calendar tool fails and you need to know whether the problem is the connection.",
    inputSchema: {},
  },
  async () =>
    attempt(async () => {
      // Probe the inbox folder, not the user object: GET /users/{mailbox}
      // needs User.Read.All, a directory permission a mail-reading app has no
      // business holding, and asking for it 403'd the one tool whose job is
      // to say the connection is fine. The folder is covered by Mail.Read,
      // the same grant the mail tools run on, so this probe fails exactly
      // when they would.
      const inbox = await graph("/mailFolders/inbox", { $select: "totalItemCount,unreadItemCount" });
      return text({
        mailbox: MAILBOX,
        inbox: { total: inbox.totalItemCount ?? null, unread: inbox.unreadItemCount ?? null },
        timezone: TIMEZONE,
        access: "read-only",
      });
    }),
);

server.registerTool(
  "m365_calendar_list",
  {
    description:
      "List calendar events in a time window, earliest first. Covers recurring meetings correctly (it expands them into actual occurrences). Defaults to the next 7 days.",
    inputSchema: {
      start: z
        .string()
        .optional()
        .describe("Start of the window, ISO 8601 (e.g. 2026-09-16T00:00:00). Defaults to now."),
      end: z
        .string()
        .optional()
        .describe("End of the window, ISO 8601. Defaults to 7 days after the start."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum events to return (default 50)."),
    },
  },
  async ({ start, end, limit }) =>
    attempt(async () => {
      const from = start ? new Date(start) : new Date();
      if (Number.isNaN(from.getTime())) return failed(`"${start}" is not a date I can read.`);
      const to = end ? new Date(end) : new Date(from.getTime() + 7 * 864e5);
      if (Number.isNaN(to.getTime())) return failed(`"${end}" is not a date I can read.`);
      if (to <= from) return failed("The end of the window must be after its start.");

      // calendarView, not /events: /events returns a recurring series as one
      // master row, so "what's on tomorrow" would miss every weekly standup.
      const data = await graph("/calendarView", {
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        $orderby: "start/dateTime",
        $top: limit ?? 50,
        $select: "id,subject,start,end,isAllDay,organizer,location,onlineMeeting,showAs,isCancelled",
      });

      const events = (data.value ?? []).map(summariseEvent);
      if (events.length === 0) {
        return text(`Nothing in the calendar between ${from.toISOString()} and ${to.toISOString()}.`);
      }
      return text({ window: { from: from.toISOString(), to: to.toISOString(), timezone: TIMEZONE }, events });
    }),
);

server.registerTool(
  "m365_calendar_get",
  {
    description:
      "Get one calendar event in full — attendees and their responses, the body, the join link. Use after m365_calendar_list when you need the detail.",
    inputSchema: { eventId: z.string().min(1).describe("The eventId from m365_calendar_list.") },
  },
  async ({ eventId }) =>
    attempt(async () => {
      const e = await graph(`/events/${encodeURIComponent(eventId)}`);
      return text({
        ...summariseEvent(e),
        attendees: (e.attendees ?? []).map((a) => ({
          who: person(a),
          type: a.type,
          response: a.status?.response,
        })),
        body: bodyText(e),
      });
    }),
);

server.registerTool(
  "m365_mail_list",
  {
    description:
      "List messages in the mailbox, newest first, with a short preview of each. Use `query` to search by word, sender or subject.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Free-text search across sender, subject and body, e.g. "invoice" or "from:anna".'),
      unreadOnly: z.boolean().optional().describe("Only messages not yet read. Ignored when `query` is set."),
      folder: z
        .string()
        .optional()
        .describe('Well-known folder: inbox (default), archive, sentitems, drafts, deleteditems.'),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum messages to return (default 15)."),
    },
  },
  async ({ query, unreadOnly, folder, limit }) =>
    attempt(async () => {
      const where = folder ? `/mailFolders/${encodeURIComponent(folder)}/messages` : "/mailFolders/inbox/messages";
      const select = "id,subject,from,sender,receivedDateTime,isRead,hasAttachments,bodyPreview";

      // Graph rejects $search combined with $filter or $orderby — searching
      // already returns by relevance. So the two modes are exclusive, and
      // `unreadOnly` is reported as ignored rather than silently dropped.
      const data = query
        ? await graph(where, { $search: `"${query.replace(/"/g, "")}"`, $top: limit ?? 15, $select: select })
        : await graph(where, {
            $orderby: "receivedDateTime desc",
            $top: limit ?? 15,
            $select: select,
            $filter: unreadOnly ? "isRead eq false" : undefined,
          });

      const messages = (data.value ?? []).map(summariseMessage);
      if (messages.length === 0) {
        return text(query ? `No messages matching "${query}".` : `No messages in ${folder ?? "inbox"}.`);
      }
      return text({
        folder: folder ?? "inbox",
        ...(query ? { searchedFor: query, note: unreadOnly ? "unreadOnly ignored: Graph cannot filter a search." : undefined } : {}),
        count: messages.length,
        messages,
      });
    }),
);

server.registerTool(
  "m365_mail_get",
  {
    description:
      "Read one message in full — the whole body, all recipients, attachment names. Use after m365_mail_list when the preview is not enough.",
    inputSchema: { messageId: z.string().min(1).describe("The messageId from m365_mail_list.") },
  },
  async ({ messageId }) =>
    attempt(async () => {
      const m = await graph(`/messages/${encodeURIComponent(messageId)}`, {
        $expand: "attachments($select=name,contentType,size)",
      });
      return text({
        ...summariseMessage(m),
        to: (m.toRecipients ?? []).map(person),
        cc: (m.ccRecipients ?? []).map(person),
        replyTo: (m.replyTo ?? []).map(person),
        conversationId: m.conversationId,
        attachments: (m.attachments ?? []).map((a) => a.name),
        body: bodyText(m),
      });
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
