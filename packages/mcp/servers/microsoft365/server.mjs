// Microsoft 365 MCP server — the secretary agent's mailbox and calendar.
//
// NOTHING HERE SENDS. That is the invariant, and it survives the arrival of
// m365_mail_draft: a draft is written into the mailbox's own Drafts folder and
// stays there. There is no tool that sends, replies, forwards, accepts,
// declines or deletes, so the worst an unattended run can do is leave a badly
// worded draft where a person will read it before anyone else does.
//
// Sending is a separate motion, performed by the hub after a named person
// approves it (packages/db/src/approvals.ts) — never from inside the agent's
// tool loop, which runs with nobody watching. Keep it that way when extending
// this file: the moment a send tool appears here, the gate is gone, because an
// agent calls the tools it holds.
//
// AUTH is app-only (OAuth 2.0 client credentials): a confidential app
// registration with Application permissions Mail.ReadWrite + Calendars.Read and
// admin consent granted. (Mail.Read alone still runs everything but the draft
// tool, which then returns Graph's 403 naming the missing permission.) There is
// no browser dance and no refresh token to rotate, which is what an unattended
// agent needs. The cost is that Application permissions span EVERY mailbox in
// the tenant, so scope this registration to the secretary's mailbox alone with
// an Application Access Policy:
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

/**
 * A Graph call that writes.
 *
 * Only ever used to create a draft. It is a separate function from `graph()`
 * rather than a `method` parameter on it so that "what in this file can write"
 * is one grep with one answer — the property the whole design rests on.
 */
async function graphWrite(path, body) {
  const token = await accessToken();
  const res = await fetch(new URL(`${GRAPH_BASE}/users/${encodeURIComponent(MAILBOX)}${path}`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer: `outlook.timezone="${TIMEZONE}"`,
    },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = payload.error ?? {};
    // A tenant that consented Mail.Read but not Mail.ReadWrite fails exactly
    // here, and Graph's own message does not name the permission. Say it, or
    // this reads as a mysterious 403 to whoever is looking at the agent output.
    const hint =
      res.status === 403
        ? " — the app registration needs the Mail.ReadWrite application permission, with admin consent granted"
        : "";
    throw new Error(`Graph ${res.status} ${err.code ?? ""}: ${err.message ?? "request failed"}${hint}`.trim());
  }
  return payload;
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
      `The mailbox and calendar of ${MAILBOX}. Use m365_calendar_list for what ` +
      "is coming up, m365_mail_list to see what has arrived, and the _get tools " +
      "when a summary is not enough and you need the full body. " +
      "m365_mail_draft writes a reply or a new message into the Drafts folder — " +
      "it does NOT send it, and you have no tool that does. A draft leaves the " +
      "tenant only after a person approves it, so write the draft in full, then " +
      "say plainly that it is waiting on a human. You cannot accept, decline, " +
      "forward or delete anything.",
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
      // Only fields Mail.Read + Calendars.Read already cover: asking for
      // mailboxSettings here would need MailboxSettings.Read and 403 the one
      // tool whose job is to tell you the connection is fine.
      const me = await graph("", { $select: "displayName,mail,userPrincipalName" });
      return text({
        mailbox: me.mail ?? me.userPrincipalName ?? MAILBOX,
        displayName: me.displayName,
        timezone: TIMEZONE,
        access: "read + draft — nothing here can send",
        // Should always be false. The sending credential is a separate app
        // registration held by the web app alone, and connectMcpServers strips
        // it from every tool server's environment (WITHHELD_FROM_TOOL_SERVERS).
        // If this ever reads true, that boundary has been broken — the process
        // running the model's tools is holding a key that can send mail.
        sendCredentialVisible: Boolean(process.env.M365_SEND_CLIENT_SECRET),
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

// An address good enough to be worth sending to Graph. Deliberately not RFC
// 5322: the job is to catch "Anna" and "anna@ example.com" before they become a
// 400 the agent has to interpret, not to adjudicate exotic legal addresses.
const looksLikeAddress = (a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.trim());

const recipients = (list) => list.map((a) => ({ emailAddress: { address: a.trim() } }));

server.registerTool(
  "m365_mail_draft",
  {
    description:
      "Write a message into the Drafts folder — a reply to something in the inbox, or a new message. " +
      "It is NOT sent: it waits in Drafts for a person to approve or send it, and nothing here can send it for you. " +
      "Prefer `replyTo` for anything answering an existing message: it keeps the conversation threaded and fills in the recipients and subject for you.",
    inputSchema: {
      body: z
        .string()
        .min(1)
        .describe("The message text you are writing. Plain text — write it in full, as it should be read."),
      replyTo: z
        .string()
        .optional()
        .describe("The messageId being replied to, from m365_mail_list. Leave empty to start a new message."),
      replyAll: z
        .boolean()
        .optional()
        .describe("With replyTo: include everyone who was on the original, not just the sender. Default false."),
      to: z
        .array(z.string())
        .optional()
        .describe("Recipients of a NEW message, as email addresses. Ignored when replyTo is set — Graph fills them in."),
      cc: z.array(z.string()).optional().describe("Copied recipients, as email addresses."),
      subject: z
        .string()
        .optional()
        .describe("Subject of a NEW message. Ignored when replyTo is set — the reply keeps the original subject."),
    },
  },
  async ({ body, replyTo, replyAll, to, cc, subject }) =>
    attempt(async () => {
      if (!body.trim()) return failed("A draft with an empty body is not worth writing.");

      const bad = [...(to ?? []), ...(cc ?? [])].filter((a) => !looksLikeAddress(a));
      if (bad.length > 0) {
        return failed(
          `These do not look like email addresses: ${bad.join(", ")}. Use m365_mail_get on the message you are answering to find the real address.`,
        );
      }

      let draft;
      let ignored;

      if (replyTo) {
        // createReply, not a fresh message with "Re:" in the subject. Graph
        // builds the draft with the right recipients, the original quoted
        // underneath, and — the part that cannot be reproduced by hand — the
        // In-Reply-To and References headers, so the answer threads in the
        // recipient's client instead of starting a new conversation.
        const path = `/messages/${encodeURIComponent(replyTo)}/${replyAll ? "createReplyAll" : "createReply"}`;
        draft = await graphWrite(path, { comment: body });
        // Say what was dropped rather than dropping it silently, the same way
        // m365_mail_list reports an ignored unreadOnly.
        const over = [to?.length ? "to" : null, subject ? "subject" : null].filter(Boolean);
        if (over.length > 0) {
          ignored = `${over.join(" and ")} ignored: a reply takes its recipients and subject from the original message.`;
        }
        if (cc?.length) {
          // A reply draft already has its recipients; adding cc means patching
          // the draft, which is a second write. Not worth it for a case nobody
          // has asked for — name the gap instead of half-doing it.
          ignored = `${ignored ? `${ignored} ` : ""}cc ignored on a reply: use replyAll, or add the copy by hand in Outlook.`;
        }
      } else {
        if (!to || to.length === 0) return failed("A new message needs at least one recipient in `to`.");
        if (!subject?.trim()) return failed("A new message needs a subject.");
        draft = await graphWrite("/messages", {
          subject: subject.trim(),
          // Plain text, not HTML: what the agent wrote is what a person will
          // read, with no markup to go wrong between here and Outlook.
          body: { contentType: "Text", content: body },
          toRecipients: recipients(to),
          ...(cc?.length ? { ccRecipients: recipients(cc) } : {}),
        });
      }

      return text({
        draftId: draft.id,
        status: "saved to Drafts — NOT sent",
        // Read back from the created draft rather than echoed from the
        // arguments: on a reply these are Graph's, not ours, and they are what
        // a person will be approving.
        subject: draft.subject,
        to: (draft.toRecipients ?? []).map(person),
        cc: (draft.ccRecipients ?? []).map(person),
        conversationId: draft.conversationId,
        openInOutlook: draft.webLink ?? null,
        ...(ignored ? { note: ignored } : {}),
        nextStep:
          "Tell the person this is waiting in Drafts and summarise what it says. You cannot send it, and neither can any other tool you hold.",
      });
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
