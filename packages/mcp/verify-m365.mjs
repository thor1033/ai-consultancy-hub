// Verification of the `microsoft365` MCP server — the secretary agent's
// read-only mailbox and calendar.
//
//   node packages/mcp/verify-m365.mjs
//
// No Microsoft tenant, no app registration, no API key, no database. A
// throwaway HTTP server stands in for login.microsoftonline.com and
// graph.microsoft.com, and the real server is pointed at it with
// M365_LOGIN_BASE_URL / M365_GRAPH_BASE_URL. Everything else is the shipping
// code path: builtinServerConfig -> connectMcpServers, exactly as an agent run
// resolves it, so a pass here means the tools work and not merely that the
// fixture agrees with itself.
//
// The fixture records every request it receives, which is what lets the checks
// below assert the things that are invisible from the tool output but decide
// whether this works against a real tenant: that the calendar reads
// /calendarView rather than /events (recurring meetings), that a search does
// not also send $orderby (Graph rejects that combination), and that the access
// token is fetched once rather than per call.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const TENANT = "test-tenant-id";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const MAILBOX = "secretary@example.com";
const ACCESS_TOKEN = "fixture-access-token";

// ── fixture data ─────────────────────────────────────────────────────────────
const EVENTS = [
  {
    id: "evt-standup",
    subject: "Weekly delivery standup",
    start: { dateTime: "2026-09-16T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-09-16T09:30:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    organizer: { emailAddress: { name: "Anna Holm", address: "anna@example.com" } },
    location: { displayName: "Teams" },
    onlineMeeting: { joinUrl: "https://teams.example.com/l/meetup/abc" },
    showAs: "busy",
    isCancelled: false,
  },
  {
    id: "evt-review",
    subject: "Helios cutover review",
    start: { dateTime: "2026-09-17T13:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-09-17T14:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    organizer: { emailAddress: { name: "Thor Simonsen", address: "thor@example.com" } },
    location: { displayName: "Meeting room 2" },
    showAs: "busy",
    isCancelled: false,
  },
];

const EVENT_DETAIL = {
  ...EVENTS[0],
  attendees: [
    { emailAddress: { name: "Anna Holm", address: "anna@example.com" }, type: "required", status: { response: "organizer" } },
    { emailAddress: { name: "Secretary", address: MAILBOX }, type: "required", status: { response: "accepted" } },
  ],
  body: { contentType: "text", content: "Agenda:\n\n1. Blockers\n2. Cutover date" },
};

const LONG_BODY = `Thanks for the update.\n\n${"detail ".repeat(700)}`;

const MESSAGES = [
  {
    id: "msg-invoice",
    subject: "Invoice 4417 overdue",
    from: { emailAddress: { name: "Accounts", address: "accounts@supplier.example" } },
    receivedDateTime: "2026-09-15T08:12:00Z",
    isRead: false,
    hasAttachments: true,
    bodyPreview: "Invoice 4417 is now 14 days overdue.",
  },
  {
    id: "msg-reschedule",
    subject: "Can we move Thursday?",
    from: { emailAddress: { name: "Anna Holm", address: "anna@example.com" } },
    receivedDateTime: "2026-09-14T16:40:00Z",
    isRead: true,
    hasAttachments: false,
    bodyPreview: "Something has come up on Thursday afternoon.",
  },
];

const MESSAGE_DETAIL = {
  ...MESSAGES[0],
  toRecipients: [{ emailAddress: { name: "Secretary", address: MAILBOX } }],
  ccRecipients: [{ emailAddress: { name: "Thor Simonsen", address: "thor@example.com" } }],
  replyTo: [],
  conversationId: "conv-1",
  attachments: [{ name: "invoice-4417.pdf", contentType: "application/pdf", size: 18422 }],
  body: { contentType: "text", content: LONG_BODY },
};

const HTML_MESSAGE = {
  id: "msg-html",
  subject: "Newsletter",
  from: { emailAddress: { name: "Marketing", address: "news@example.com" } },
  receivedDateTime: "2026-09-13T07:00:00Z",
  isRead: true,
  hasAttachments: false,
  bodyPreview: "This month at Example",
  body: {
    contentType: "html",
    content: "<html><style>.x{color:red}</style><body><p>Quarterly results</p><p>are <b>up</b>.</p></body></html>",
  },
};

// ── the throwaway tenant ─────────────────────────────────────────────────────
const requests = [];
let tokenRequests = 0;

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // login.microsoftonline.com
  if (req.method === "POST" && url.pathname === `/${TENANT}/oauth2/v2.0/token`) {
    tokenRequests++;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    if (form.get("client_secret") !== CLIENT_SECRET || form.get("grant_type") !== "client_credentials") {
      return json(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret." });
    }
    return json(200, { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" });
  }

  // graph.microsoft.com — everything past here needs the bearer token.
  requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
  if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
    return json(401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });
  }

  const base = `/users/${encodeURIComponent(MAILBOX)}`;
  const rest = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
  if (rest === null) return json(404, { error: { code: "ResourceNotFound", message: "No such mailbox." } });

  if (rest === "") {
    return json(200, { displayName: "Secretary", mail: MAILBOX, userPrincipalName: MAILBOX });
  }
  if (rest === "/calendarView") {
    const from = new Date(url.searchParams.get("startDateTime"));
    const to = new Date(url.searchParams.get("endDateTime"));
    const within = EVENTS.filter((e) => {
      const at = new Date(e.start.dateTime + "Z");
      return at >= from && at <= to;
    });
    return json(200, { value: within });
  }
  if (rest === "/events/evt-standup") return json(200, EVENT_DETAIL);
  if (rest.startsWith("/events/")) {
    return json(404, { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } });
  }
  if (rest === "/mailFolders/inbox/messages" || rest === "/mailFolders/archive/messages") {
    if (url.searchParams.has("$search")) return json(200, { value: [MESSAGES[0]] });
    const filter = url.searchParams.get("$filter");
    const value = filter === "isRead eq false" ? MESSAGES.filter((m) => !m.isRead) : MESSAGES;
    return json(200, { value });
  }
  if (rest === "/messages/msg-invoice") return json(200, MESSAGE_DETAIL);
  if (rest === "/messages/msg-html") return json(200, HTML_MESSAGE);
  if (rest.startsWith("/messages/")) {
    return json(404, { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } });
  }
  return json(404, { error: { code: "ResourceNotFound", message: `No route for ${rest}.` } });
});

await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${http.address().port}`;

// The server reads these at import time, and connectMcpServers spawns it as a
// child process inheriting this environment.
Object.assign(process.env, {
  M365_TENANT_ID: TENANT,
  M365_CLIENT_ID: CLIENT_ID,
  M365_CLIENT_SECRET: CLIENT_SECRET,
  M365_MAILBOX: MAILBOX,
  M365_LOGIN_BASE_URL: origin,
  M365_GRAPH_BASE_URL: origin,
  M365_TIMEZONE: "Europe/Copenhagen",
});

const { connectMcpServers } = await import("./src/manager.ts");
const { builtinServerConfig } = await import("./src/servers.ts");

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const lastRequest = (match) => [...requests].reverse().find((r) => r.path.includes(match));

try {
  const cfg = builtinServerConfig("microsoft365");
  check("microsoft365 resolves as a built-in server", cfg !== null, cfg ? cfg.args[0].split("/").slice(-3).join("/") : "null");

  const mcp = await connectMcpServers([cfg]);
  try {
    const names = mcp.tools.map((t) => t.name).sort();
    check("the server connects over stdio and lists its tools", names.length === 5, names.join(", "));

    // ── read-only is the whole safety story, so assert it rather than trust it.
    const writeish = names.filter((n) => /send|reply|forward|create|update|delete|accept|decline|move/i.test(n));
    check("no tool can send, reply or change anything", writeish.length === 0, writeish.join(", ") || "read-only");

    // ── connection ───────────────────────────────────────────────────────────
    const who = parse(await mcp.execute("m365_whoami", {}));
    check("m365_whoami reports the mailbox it is reading", who.mailbox === MAILBOX, who.mailbox ?? String(who).slice(0, 60));
    check("and reports itself as read-only", who.access === "read-only", who.access);

    const auth = lastRequest("/users/")?.headers.authorization;
    check("Graph is called with the token from the client-credentials grant", auth === `Bearer ${ACCESS_TOKEN}`);
    check(
      "bodies are requested as plain text, not Outlook HTML",
      /outlook\.body-content-type="text"/.test(lastRequest("/users/")?.headers.prefer ?? ""),
      lastRequest("/users/")?.headers.prefer,
    );

    // ── calendar ─────────────────────────────────────────────────────────────
    const week = parse(await mcp.execute("m365_calendar_list", { start: "2026-09-15T00:00:00Z", end: "2026-09-20T00:00:00Z" }));
    check("m365_calendar_list returns the events in the window", week.events?.length === 2, `${week.events?.length} events`);
    check(
      "each event carries what you need to act on it",
      week.events?.[0].subject === "Weekly delivery standup" &&
        week.events[0].online?.startsWith("https://") &&
        week.events[0].organiser?.includes("anna@example.com"),
      week.events?.[0]?.subject,
    );

    // The reason this is calendarView and not /events: /events returns a
    // recurring series as a single master row, so a weekly standup would be
    // missing from "what's on tomorrow" on every week but the first.
    const calReq = lastRequest("/calendarView");
    check("the calendar is read through calendarView, so recurring meetings expand", Boolean(calReq));
    check("and is ordered by start time", calReq?.query.get("$orderby") === "start/dateTime", calReq?.query.get("$orderby"));

    const empty = await mcp.execute("m365_calendar_list", { start: "2026-12-01T00:00:00Z", end: "2026-12-02T00:00:00Z" });
    check("an empty window says so in words rather than returning []", /nothing in the calendar/i.test(empty), empty.slice(0, 50));

    const badDate = await mcp.execute("m365_calendar_list", { start: "next tuesday" });
    check("an unreadable date is refused before it reaches Graph", /not a date I can read/i.test(badDate), badDate.slice(0, 60));

    const backwards = await mcp.execute("m365_calendar_list", { start: "2026-09-20T00:00:00Z", end: "2026-09-15T00:00:00Z" });
    check("a backwards window is refused", /end of the window must be after/i.test(backwards), backwards.slice(0, 60));

    const detail = parse(await mcp.execute("m365_calendar_get", { eventId: "evt-standup" }));
    check(
      "m365_calendar_get returns attendees and their responses",
      detail.attendees?.length === 2 && detail.attendees[1].response === "accepted",
      `${detail.attendees?.length} attendees`,
    );
    check("and the event body", /Blockers/.test(detail.body ?? ""), (detail.body ?? "").slice(0, 40).replace(/\n/g, " "));

    // ── mail ─────────────────────────────────────────────────────────────────
    const inbox = parse(await mcp.execute("m365_mail_list", {}));
    check("m365_mail_list returns the inbox with previews", inbox.messages?.length === 2, `${inbox.messages?.length} messages`);
    check(
      "newest first",
      lastRequest("/mailFolders/inbox/messages")?.query.get("$orderby") === "receivedDateTime desc",
    );
    check(
      "unread state and attachments are visible without opening the message",
      inbox.messages?.[0].unread === true && inbox.messages[0].hasAttachments === true,
    );

    const unread = parse(await mcp.execute("m365_mail_list", { unreadOnly: true }));
    check("unreadOnly filters server-side", unread.messages?.length === 1, lastRequest("/mailFolders/inbox/messages")?.query.get("$filter"));

    const found = parse(await mcp.execute("m365_mail_list", { query: "invoice" }));
    check("a query searches the mailbox", found.messages?.length === 1 && found.searchedFor === "invoice");

    // Graph returns 400 when $search is combined with $orderby or $filter, so
    // the search path must send neither. This is the check that catches it.
    const searchReq = lastRequest("/mailFolders/inbox/messages");
    check(
      "a search sends $search alone — Graph rejects it alongside $orderby or $filter",
      searchReq?.query.has("$search") && !searchReq.query.has("$orderby") && !searchReq.query.has("$filter"),
      [...(searchReq?.query.keys() ?? [])].join(" "),
    );

    const bothFlags = parse(await mcp.execute("m365_mail_list", { query: "invoice", unreadOnly: true }));
    check(
      "combining query with unreadOnly says the filter was ignored rather than dropping it silently",
      /ignored/i.test(bothFlags.note ?? ""),
      bothFlags.note,
    );

    const archive = parse(await mcp.execute("m365_mail_list", { folder: "archive" }));
    check("another well-known folder can be listed", archive.folder === "archive" && archive.messages?.length === 2);

    const message = parse(await mcp.execute("m365_mail_get", { messageId: "msg-invoice" }));
    check(
      "m365_mail_get returns recipients and attachment names",
      message.cc?.[0]?.includes("thor@example.com") && message.attachments?.[0] === "invoice-4417.pdf",
      message.attachments?.join(", "),
    );
    check(
      "a long body is truncated with a note rather than flooding the transcript",
      message.body.length < 4300 && /truncated, \d+ more characters/.test(message.body),
      `${message.body.length} chars`,
    );

    const html = parse(await mcp.execute("m365_mail_get", { messageId: "msg-html" }));
    check(
      "an HTML body is reduced to readable text, styles and tags stripped",
      /Quarterly results/.test(html.body) && !/<|color:red/.test(html.body),
      html.body?.slice(0, 50),
    );

    // ── failure ──────────────────────────────────────────────────────────────
    const missingMsg = await mcp.execute("m365_mail_get", { messageId: "msg-nope" });
    check(
      "a Graph error reaches the agent with its code, not as a blank answer",
      /Tool error/.test(missingMsg) && /ErrorItemNotFound/.test(missingMsg),
      missingMsg.slice(0, 70),
    );

    const missingEvent = await mcp.execute("m365_calendar_get", { eventId: "evt-nope" });
    check("the same for a missing event", /Tool error/.test(missingEvent) && /404/.test(missingEvent));

    // ── the token ────────────────────────────────────────────────────────────
    check(
      "the access token is fetched once and reused across every call",
      tokenRequests === 1,
      `${tokenRequests} token request(s) for ${requests.length} Graph calls`,
    );
  } finally {
    await mcp.close();
  }

  // ── it must refuse to run unconfigured ─────────────────────────────────────
  // Otherwise a deployment missing its secret gets an agent that appears to work
  // and reports an empty inbox.
  const here = dirname(fileURLToPath(import.meta.url));
  const unconfigured = await new Promise((resolve) => {
    const env = { ...process.env };
    delete env.M365_CLIENT_SECRET;
    const child = spawn(process.execPath, [join(here, "servers", "microsoft365", "server.mjs")], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  check(
    "the server refuses to start when a credential is missing, naming it",
    unconfigured.code === 1 && /M365_CLIENT_SECRET/.test(unconfigured.stderr),
    unconfigured.stderr.trim().slice(0, 80),
  );

  // A wrong secret must be diagnosable from the tool output alone.
  process.env.M365_CLIENT_SECRET = "wrong-secret";
  const badMcp = await connectMcpServers([builtinServerConfig("microsoft365")]);
  try {
    const out = await badMcp.execute("m365_whoami", {});
    check(
      "a rejected client secret surfaces the AADSTS code",
      /Tool error/.test(out) && /AADSTS7000215/.test(out),
      out.slice(0, 80),
    );
  } finally {
    await badMcp.close();
    process.env.M365_CLIENT_SECRET = CLIENT_SECRET;
  }
} finally {
  http.close();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(
  failedChecks.length === 0
    ? `\nMicrosoft 365 MCP server OK (${checks.length} checks)`
    : `\nMicrosoft 365 MCP server FAILED (${failedChecks.length}/${checks.length})`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
