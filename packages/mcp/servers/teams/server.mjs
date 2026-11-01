// Microsoft Teams MCP server — meeting transcripts and the team's files.
//
// ONE FILE, TWO SERVERS. The hub starts it as `teams` (HUB_TEAMS_MODE=read) or
// as `teams-notes` (HUB_TEAMS_MODE=notes), and an agent is given each one
// separately (servers.ts sets the mode; the model never can):
//
//   teams        READ-ONLY, like servers/microsoft365. Nothing that uploads,
//                edits, moves, shares or deletes.
//   teams-notes  ONE tool, teams_notes_save, which creates a NEW Markdown file
//                in ONE folder (M365_TEAMS_NOTES_FOLDER). It cannot overwrite:
//                the upload asks Graph to fail on a name that exists, and a
//                clash becomes "… (2).md". It cannot write anywhere else: the
//                folder is the deployment's configuration, not an argument.
//
// Splitting them is the point. An agent that reads transcripts does not gain
// the ability to write because a deployment configured a notes folder; only an
// agent someone ticked `teams-notes` on can. Microsoft cannot fence a folder —
// Sites.Selected grants write on the whole site — so the folder is fenced here,
// by having no tool that takes a path to write to.
//
// TWO HALVES, each configured on its own, each fenced by Microsoft rather than
// by this file:
//
//   Transcripts  M365_TEAMS_ORGANIZER_ID — the Entra object id of the person
//                whose meetings are read. Application permissions
//                OnlineMeetings.Read.All + OnlineMeetingTranscript.Read.All do
//                nothing on their own: a Teams application access policy has to
//                be granted to that one user (Grant-CsApplicationAccessPolicy),
//                and Graph refuses every other organiser.
//   Files        M365_TEAMS_SITE_URL — the team's SharePoint site. Application
//                permission Sites.Selected starts with access to NO site; an
//                admin grants read on this one. The default document library of
//                a team site is the team's "Files"/"Shared" tab.
//
// FINDING TRANSCRIPTS takes two routes, because Microsoft's bulk listing
// (getAllTranscripts) does not return CHANNEL meetings — the very meetings
// this server shares. So channel meetings are found through a calendar
// instead: M365_TEAMS_CALENDAR (default M365_MAILBOX, the secretary's
// mailbox) is read for events with a Teams join link, each link is resolved to
// its meeting under the organiser (onlineMeetings?$filter=JoinWebUrl eq …),
// and that meeting's transcripts are listed one meeting at a time, which
// Microsoft does support for channel meetings. Invite the calendar's mailbox
// to a meeting series and its transcripts become findable; a "Meet now" in a
// channel has no invitation and is not. The bulk listing still runs, for the
// organiser's other meetings. The calendar read rides on Calendars.Read and
// the same Exchange access policy as microsoft365.
//
// The organiser's meetings include private ones — a one-to-one with a client
// is as reachable as the team's standing meeting. So by default only CHANNEL
// meetings are served: they are the ones everyone in the team can already see,
// which is what makes it fair to hand them to an agent anyone on the hub can
// run. M365_TEAMS_PRIVATE_MEETINGS=1 widens that, deliberately.
//
// AUTH is the same app-only client-credentials grant as microsoft365 (M365_*),
// so one app registration serves both. Like the other bundled servers this runs
// as a bare `node server.mjs` child process: native fetch, and nothing from
// @ai-hub/*, whose TypeScript sources only a bundler resolves. See docs/teams.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { READABLE, canRead, extOf, fileText, tidy, turnsToText, vttToTurns } from "../fileText.mjs";
import { z } from "zod";

const TENANT_ID = process.env.M365_TENANT_ID;
const CLIENT_ID = process.env.M365_CLIENT_ID;
const CLIENT_SECRET = process.env.M365_CLIENT_SECRET;
const ORGANIZER = process.env.M365_TEAMS_ORGANIZER_ID?.trim() || "";
const SITE_URL = process.env.M365_TEAMS_SITE_URL?.trim() || "";
const INCLUDE_PRIVATE = process.env.M365_TEAMS_PRIVATE_MEETINGS === "1";
// Anything but exactly "notes" is the read server: an unset or mistyped mode
// must not be the one that writes.
const MODE = process.env.HUB_TEAMS_MODE === "notes" ? "notes" : "read";
const NOTES_FOLDER_RAW = process.env.M365_TEAMS_NOTES_FOLDER?.trim() || "";
// Whose calendar lists the meetings to look in: the secretary's mailbox by
// default. Empty means channel-meeting transcripts cannot be found (see the
// header), and teams_status says so.
const CALENDAR = (process.env.M365_TEAMS_CALENDAR?.trim() || process.env.M365_MAILBOX?.trim() || "").toLowerCase();

// Overridable so verify-teams.mjs can point the whole server at a local fixture.
// Never set these in production.
const GRAPH_BASE = process.env.M365_GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0";
const LOGIN_BASE = process.env.M365_LOGIN_BASE_URL ?? "https://login.microsoftonline.com";
const TIMEZONE = process.env.M365_TIMEZONE ?? "UTC";

// stdout is the JSON-RPC channel, so every refusal goes to stderr.
function refuse(message) {
  console.error(`[${MODE === "notes" ? "teams-notes" : "teams"}] ${message} Refusing to start.`);
  process.exit(1);
}

const missing = [
  ["M365_TENANT_ID", TENANT_ID],
  ["M365_CLIENT_ID", CLIENT_ID],
  ["M365_CLIENT_SECRET", CLIENT_SECRET],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) refuse(`not configured — missing ${missing.join(", ")}.`);
if (MODE === "read" && !ORGANIZER && !SITE_URL) {
  refuse("nothing to serve — set M365_TEAMS_ORGANIZER_ID (transcripts), M365_TEAMS_SITE_URL (files), or both.");
}
// Notes are written from a transcript, into the team's files: both halves, and
// the folder, or there is nothing this server can do.
if (MODE === "notes") {
  const need = [
    ["M365_TEAMS_ORGANIZER_ID", ORGANIZER],
    ["M365_TEAMS_SITE_URL", SITE_URL],
    ["M365_TEAMS_NOTES_FOLDER", NOTES_FOLDER_RAW],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (need.length > 0) refuse(`not configured for notes — missing ${need.join(", ")}.`);
}

// The notes folder, as path segments. Checked once at startup, because it is
// the one place this server writes: no "..", no empty or dot segments, none of
// the characters SharePoint refuses in a name.
let NOTES_SEGMENTS = [];
if (NOTES_FOLDER_RAW) {
  NOTES_SEGMENTS = NOTES_FOLDER_RAW.split("/").map((s) => s.trim()).filter(Boolean);
  const bad = NOTES_SEGMENTS.find((s) => s === "." || s === ".." || /["*:<>?\\|#%\u0000-\u001f]/.test(s));
  if (NOTES_SEGMENTS.length === 0 || bad !== undefined) {
    refuse(`M365_TEAMS_NOTES_FOLDER must be a folder path inside the team's files, e.g. "Meetings/Notes" — got "${NOTES_FOLDER_RAW}".`);
  }
}
const NOTES_FOLDER = NOTES_SEGMENTS.join("/");

// The meetings API addresses users by object id; a UPN here would fail on
// every call with an error that does not say why. Resolving one would need
// User.Read.All, a tenant-wide directory read, to save copying a GUID once.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (ORGANIZER && !GUID.test(ORGANIZER)) {
  refuse(
    `M365_TEAMS_ORGANIZER_ID must be the organiser's Entra object id (a GUID), not "${ORGANIZER}". ` +
      "Entra admin centre → Users → the person → Object ID.",
  );
}

let SITE = null;
if (SITE_URL) {
  try {
    const u = new URL(SITE_URL);
    const path = u.pathname.replace(/\/+$/, "");
    if (!path || path === "/") throw new Error("no site path");
    SITE = { host: u.hostname, path };
  } catch {
    refuse(`M365_TEAMS_SITE_URL must be the site's address, e.g. https://contoso.sharepoint.com/sites/Team — got "${SITE_URL}".`);
  }
}

// ── token ────────────────────────────────────────────────────────────────────
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
    throw new Error(
      `Microsoft sign-in failed (${res.status}): ${body.error_description ?? body.error ?? "unknown error"}`,
    );
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

// ── Graph ────────────────────────────────────────────────────────────────────
class GraphError extends Error {
  constructor(status, code, innerCode, message) {
    super(`Graph ${status} ${code ?? ""}${innerCode ? ` (${innerCode})` : ""}: ${message ?? "request failed"}`.replace(/ +:/, ":"));
    this.status = status;
    this.innerCode = innerCode;
  }
}

async function graphFetch(target, { search = {}, accept, method = "GET", json } = {}) {
  const url = new URL(target.startsWith("http") ? target : `${GRAPH_BASE}${target}`);
  // Paging links come back from Graph as absolute URLs. The token only ever
  // goes to Graph itself, whatever a response says the next page is.
  if (!url.href.startsWith(`${GRAPH_BASE}/`)) throw new Error(`Refusing to follow a link outside Graph: ${url.origin}`);
  for (const [k, v] of Object.entries(search)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      ...(accept ? { accept } : {}),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))).error ?? {};
    throw new GraphError(res.status, err.code, err.innerError?.code ?? err.innererror?.code, err.message);
  }
  return res;
}

const graphJson = async (target, search) => (await graphFetch(target, { search })).json();

/** Follows @odata.nextLink until `max` items or `pages` pages. */
async function graphAll(target, search, { max = 500, pages = 10 } = {}) {
  const items = [];
  let next = target;
  let first = true;
  for (let i = 0; next && i < pages && items.length < max; i++) {
    const body = await graphJson(next, first ? search : undefined);
    first = false;
    items.push(...(body.value ?? []));
    next = body["@odata.nextLink"];
  }
  return { items: items.slice(0, max), more: Boolean(next) || items.length > max };
}

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failed = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

// What to do about a refusal, by which half refused. The status alone is the
// whole diagnosis surprisingly often, and the agent is the one who has to
// relay it to a person who can fix the tenant.
function hintFor(area, err) {
  if (err.innerCode === "GraphAccessToTranscriptsDisabled") {
    return (
      "A tenant administrator has turned off Graph access to meeting transcripts. Nothing on this side can work " +
      "around it; an admin turns it on with: Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess $true"
    );
  }
  if (area === "meetings" && (err.status === 401 || err.status === 403)) {
    return (
      "The app needs OnlineMeetings.Read.All and OnlineMeetingTranscript.Read.All (Application, admin-consented) " +
      "and a Teams application access policy granted to the organiser. Policies can take 30 minutes to apply. See docs/teams.md."
    );
  }
  if (area === "files" && (err.status === 401 || err.status === 403)) {
    return (
      "The app needs Sites.Selected with read access granted on this site, granted to its Application (client) ID " +
      "(not its Object ID). See docs/teams.md."
    );
  }
  if (area === "notes" && (err.status === 401 || err.status === 403)) {
    return (
      "If this came from saving the file, the app may read the site but not write to it: an admin grants write with " +
      'the same Graph Explorer call as read, with "roles": ["write"]. If it came from the meeting, see teams_status. See docs/teams.md.'
    );
  }
  if (area === "meetings" && err.status === 404) {
    return "Check the ids came from teams_meetings_list. If they did, Teams no longer has it: a meeting's transcripts go when the meeting expires, or when someone deletes them.";
  }
  return "";
}

/** Tool bodies differ; their failure mode does not. */
async function attempt(area, fn) {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = err instanceof GraphError ? hintFor(area, err) : "";
    return failed(hint ? `${message}\n${hint}` : message);
  }
}

const localTime = (iso) =>
  iso && !Number.isNaN(new Date(iso).getTime())
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: TIMEZONE,
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : null;

// Long text comes back a page at a time rather than truncated: a transcript is
// read for what was decided near the end as often as for how it began, so
// cutting it off silently would be a wrong answer that looks like a right one.
const PAGE_CHARS = 60_000;

function page(body, offset = 0) {
  const total = body.length;
  if (offset >= total && total > 0) return { slice: "", header: `Offset ${offset} is past the end (${total} characters).` };
  let end = Math.min(offset + PAGE_CHARS, total);
  if (end < total) {
    const nl = body.lastIndexOf("\n", end);
    if (nl > offset) end = nl + 1;
  }
  const header =
    end < total
      ? `Characters ${offset}–${end} of ${total}. There is more: call again with offset=${end}.`
      : offset > 0
        ? `Characters ${offset}–${total} of ${total} (the end).`
        : null;
  return { slice: body.slice(offset, end), header };
}

// ── meetings ─────────────────────────────────────────────────────────────────
const MEETINGS_OFF =
  "Meeting transcripts are not set up on this deployment: M365_TEAMS_ORGANIZER_ID is missing. See docs/teams.md.";

// Channel meetings carry the channel's own thread (19:…@thread.tacv2, or
// @thread.skype for old teams). Private and chat meetings carry a
// 19:meeting_…@thread.v2 or chat thread instead.
const isChannelMeeting = (m) => /@thread\.(tacv2|skype)$/i.test(m?.chatInfo?.threadId ?? "");
const inScope = (m) => INCLUDE_PRIVATE || isChannelMeeting(m);
const OUT_OF_SCOPE =
  "That transcript is from a meeting outside a Teams channel. This deployment shares channel meetings only " +
  "(they are the ones the whole team can already see); a person can turn on M365_TEAMS_PRIVATE_MEETINGS=1 to widen it.";

const meetingsPath = `/users/${ORGANIZER}/onlineMeetings`;
const meetingCache = new Map();

function meeting(meetingId) {
  if (!meetingCache.has(meetingId)) {
    meetingCache.set(
      meetingId,
      graphJson(`${meetingsPath}/${encodeURIComponent(meetingId)}`).catch((err) => {
        meetingCache.delete(meetingId);
        throw err;
      }),
    );
  }
  return meetingCache.get(meetingId);
}

const summariseTranscript = (t, m) => ({
  meetingId: t.meetingId,
  transcriptId: t.id,
  meeting: m?.subject || "(untitled meeting)",
  when: localTime(t.createdDateTime),
  started: t.createdDateTime,
  ended: t.endDateTime ?? null,
  minutes:
    t.endDateTime && t.createdDateTime
      ? Math.max(1, Math.round((new Date(t.endDateTime) - new Date(t.createdDateTime)) / 60_000))
      : null,
  channelMeeting: isChannelMeeting(m),
});

// The organiser's object id, from the `context` a classic join link carries
// ({"Tid":…,"Oid":…}). Null when the link has none, e.g. the short /meet/ form.
function organiserOf(url) {
  try {
    const oid = JSON.parse(new URL(url).searchParams.get("context") ?? "")?.Oid;
    return typeof oid === "string" ? oid.toLowerCase() : null;
  } catch {
    return null;
  }
}

// How Graph finds a meeting from its link: a short /meet/<id> link by its
// numeric meeting id, a classic one by the link itself. Quotes are doubled
// for OData.
function meetingFilter(url) {
  const id = url.match(/^https:\/\/teams\.microsoft\.com\/meet\/(\d+)/i)?.[1];
  return id ? `joinMeetingIdSettings/joinMeetingId eq '${id}'` : `JoinWebUrl eq '${url.replace(/'/g, "''")}'`;
}

/**
 * Transcripts of the meetings on CALENDAR between `from` and `to`, found one
 * meeting at a time (see the header for why the bulk listing cannot).
 *
 * Never throws: a calendar the app may not read, or a meeting it cannot
 * resolve, becomes a note, so the caller still shows what the bulk route
 * found. `seen` counts what was looked at, which is what teams_status reports
 * and what a person needs to tell "no transcription" from "not reachable".
 */
async function calendarTranscripts(from, to) {
  const seen = { calendar: CALENDAR || null, teamsMeetings: 0, resolved: 0, transcripts: 0, otherOrganisers: [] };
  const notes = [];
  if (!CALENDAR) {
    notes.push(
      "Channel-meeting transcripts cannot be found: no calendar is set to look in (M365_TEAMS_CALENDAR or M365_MAILBOX). " +
        "Microsoft's bulk transcript listing leaves channel meetings out; see docs/teams.md.",
    );
    return { items: [], notes, seen };
  }

  let events;
  try {
    ({ items: events } = await graphAll(
      `/users/${encodeURIComponent(CALENDAR)}/calendarView`,
      {
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        $select: "subject,start,organizer,isOnlineMeeting,onlineMeeting",
        $top: 100,
      },
      { max: 500, pages: 5 },
    ));
  } catch (err) {
    notes.push(
      `Could not read ${CALENDAR}'s calendar to find channel meetings: ${err.message}. ` +
        "It needs Calendars.Read (Application) and to be inside the Exchange access policy's group, like the microsoft365 mailbox.",
    );
    return { items: [], notes, seen };
  }

  // A series has one join link for every occurrence: resolve each link once.
  const links = new Map();
  for (const e of events) {
    const url = e.onlineMeeting?.joinUrl;
    if (typeof url === "string" && /^https:\/\/teams\.microsoft\.com\//i.test(url) && !links.has(url)) links.set(url, e);
  }
  seen.teamsMeetings = links.size;

  const items = [];
  const others = new Set();
  const unmatched = [];
  await Promise.all(
    [...links].map(async ([url, event]) => {
      const title = event.subject ?? "a meeting";
      // The event's organiser is no help for a channel meeting: it is the
      // team's group mailbox, not a person. The join link names the real one.
      const oid = organiserOf(url);
      if (oid && oid !== ORGANIZER.toLowerCase()) {
        others.add(`"${title}" (organiser id ${oid})`);
        return;
      }
      let m;
      try {
        const found = await graphJson(meetingsPath, { $filter: meetingFilter(url) });
        m = found.value?.[0];
      } catch (err) {
        notes.push(`Could not look up "${title}": ${err.message}`);
        return;
      }
      if (!m) {
        // Graph only finds meetings under the organiser the access policy
        // covers. A link that names that organiser and still does not resolve
        // is Microsoft not matching it, which is worth saying differently.
        if (oid) unmatched.push(title);
        else others.add(`"${title}" (${event.organizer?.emailAddress?.address ?? "organiser unknown"})`);
        return;
      }
      seen.resolved++;
      meetingCache.set(m.id, Promise.resolve(m));
      try {
        const { items: ts } = await graphAll(`${meetingsPath}/${encodeURIComponent(m.id)}/transcripts`, undefined, { max: 200, pages: 5 });
        for (const t of ts) {
          const at = new Date(t.createdDateTime);
          if (at >= from && at <= to) items.push({ ...t, meetingId: t.meetingId ?? m.id });
        }
      } catch (err) {
        notes.push(`Could not list the transcripts of "${m.subject ?? event.subject ?? "a meeting"}": ${err.message}`);
      }
    }),
  );
  seen.transcripts = items.length;
  seen.otherOrganisers = [...others];
  if (others.size) {
    notes.push(
      `Not organised by the configured organiser, so their transcripts cannot be read: ${[...others].join(", ")}. ` +
        "Only meetings organised by the person in M365_TEAMS_ORGANIZER_ID are reachable.",
    );
  }
  if (unmatched.length) {
    notes.push(
      `Microsoft did not match the join link of ${unmatched.map((t) => `"${t}"`).join(", ")} to a meeting, ` +
        "although the link names the configured organiser. Its transcripts cannot be listed this way.",
    );
  }
  return { items, notes, seen };
}

// ── files ────────────────────────────────────────────────────────────────────
const FILES_OFF = "The team's files are not set up on this deployment: M365_TEAMS_SITE_URL is missing. See docs/teams.md.";

let driveCache = null;

/** The site's default document library: the team's Files tab. Resolved once. */
function drive() {
  if (!driveCache) {
    driveCache = (async () => {
      const site = await graphJson(`/sites/${SITE.host}:${SITE.path}`, { $select: "id,displayName,webUrl" });
      const lib = await graphJson(`/sites/${site.id}/drive`, { $select: "id,name,webUrl" });
      return { id: lib.id, site: site.displayName, library: lib.name, webUrl: lib.webUrl ?? site.webUrl };
    })().catch((err) => {
      driveCache = null;
      throw err;
    });
  }
  return driveCache;
}

const ITEM_FIELDS = "id,name,size,file,folder,webUrl,lastModifiedDateTime,lastModifiedBy,parentReference";

function humanSize(bytes) {
  if (typeof bytes !== "number") return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** "/drives/x/root:/General/Plans" + name → "General/Plans/name". */
function itemPath(item) {
  const parent = item.parentReference?.path;
  if (typeof parent !== "string") return null;
  const within = decodeURIComponent(parent.replace(/^.*?root:?/, "")).replace(/^\/+/, "");
  return within ? `${within}/${item.name}` : item.name;
}

const summariseItem = (i) => ({
  itemId: i.id,
  name: i.name,
  kind: i.folder ? "folder" : "file",
  ...(i.folder ? { items: i.folder.childCount ?? null } : { size: humanSize(i.size) }),
  path: itemPath(i),
  modified: localTime(i.lastModifiedDateTime),
  // To the second, and zone-free: `modified` is for a person and rounds to the
  // minute, which would let the knowledge-base sync miss an edit made within a
  // minute of the last one.
  modifiedAt: i.lastModifiedDateTime ?? null,
  modifiedBy: i.lastModifiedBy?.user?.displayName ?? null,
  webUrl: i.webUrl ?? null,
});

/** A drive-relative path, each segment encoded, or "" for the root. */
function encodePath(path) {
  const segments = (path ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  return segments.map(encodeURIComponent).join("/");
}

// ── reading files as text ────────────────────────────────────────────────────
const MAX_DOWNLOAD = 30 * 1024 ** 2;

// ── server ───────────────────────────────────────────────────────────────────
const halves = [
  ORGANIZER && "meeting transcripts (teams_meetings_list, then teams_transcript_get)",
  SITE && "the team's files (teams_files_list, teams_files_search, teams_file_read)",
].filter(Boolean);

const server = new McpServer(
  { name: MODE === "notes" ? "teams-notes" : "teams", version: "0.2.0" },
  {
    instructions:
      MODE === "notes"
        ? `Save meeting notes to the team's files with teams_notes_save: one new Markdown file in "${NOTES_FOLDER}" ` +
          "per call. Read the meeting's whole transcript first (teams_meetings_list and teams_transcript_get, " +
          "from the teams server). The file's layout is fixed; you supply the content. It never changes or " +
          "deletes an existing file — saving twice makes a second file."
        : `Read-only access to Microsoft Teams: ${halves.join(" and ")}. ` +
          "Transcripts are timestamped and labelled by speaker; Teams' speaker labels can be wrong when people " +
          "share a device or an account, so check them against what is said. Long transcripts and files come back " +
          "a page at a time — when a result says there is more, call again with the offset it gives. You cannot " +
          "upload, edit, move, share or delete anything from here. Use teams_status when a tool fails and you need " +
          "to know which half of the connection is broken.",
  },
);

// The read tools exist only on the read server, the write tool only on the
// notes server. Registration is the fence: a tool that was never registered
// cannot be called, whatever the model asks for.
//
// Each tool also SAYS which it is (readOnlyHint). The hub's approval gate
// holds any tool not declared read-only for a person, so the read tools
// declare it and pass, and teams_notes_save declares the opposite and is held
// until someone approves the file it would create.
const withHint = (hint) => (name, config, handler) =>
  server.registerTool(name, { ...config, annotations: { ...hint, ...(config.annotations ?? {}) } }, handler);
const readTool = MODE === "read" ? withHint({ readOnlyHint: true }) : () => {};
const notesTool = MODE === "notes" ? withHint({ readOnlyHint: false, destructiveHint: false }) : () => {};

readTool(
  "teams_status",
  {
    description:
      "Check which parts of the Teams connection are set up and working: meeting transcripts, the team's files, or both. Use it when another teams_ tool fails, before telling someone what is wrong.",
    inputSchema: {},
  },
  async () => {
    const report = { access: "read-only" };
    if (ORGANIZER) {
      report.transcripts = {
        organiserId: ORGANIZER,
        shares: INCLUDE_PRIVATE ? "every meeting the organiser runs" : "channel meetings only",
      };
      try {
        const day = new Date(Date.now() - 864e5).toISOString();
        await graphJson(
          `${meetingsPath}/getAllTranscripts(meetingOrganizerUserId='${ORGANIZER}',startDateTime=${day},endDateTime=${new Date().toISOString()})`,
          { $top: 1 },
        );
        report.transcripts.working = true;
        // The probe a person needs when the list is empty: did the calendar
        // route see the meetings, resolve them, and find transcripts?
        const to = new Date();
        const found = await calendarTranscripts(new Date(to.getTime() - 14 * 864e5), to);
        report.transcripts.channelMeetings = {
          calendar: found.seen.calendar,
          last14Days: {
            teamsMeetingsOnCalendar: found.seen.teamsMeetings,
            organisedByOrganiser: found.seen.resolved,
            transcriptsFound: found.seen.transcripts,
          },
          ...(found.notes.length ? { notes: found.notes } : {}),
        };
      } catch (err) {
        report.transcripts.working = false;
        report.transcripts.error = [err.message, err instanceof GraphError ? hintFor("meetings", err) : ""].filter(Boolean).join(" ");
      }
    } else {
      report.transcripts = { working: false, error: MEETINGS_OFF };
    }
    if (SITE) {
      try {
        const d = await drive();
        report.files = { working: true, site: d.site, library: d.library, webUrl: d.webUrl };
      } catch (err) {
        report.files = {
          working: false,
          site: SITE_URL,
          error: [err.message, err instanceof GraphError ? hintFor("files", err) : ""].filter(Boolean).join(" "),
        };
      }
    } else {
      report.files = { working: false, error: FILES_OFF };
    }
    // Reported from the read server so one tool answers "what is set up". It
    // can say whether the folder exists; whether the app may write there is
    // proven only by the first save (there is no read-only way to ask).
    if (NOTES_FOLDER && SITE) {
      try {
        const d = await drive();
        await graphJson(`/drives/${d.id}/root:/${encodePath(NOTES_FOLDER)}`, { $select: "id,folder" });
        report.notes = { folder: NOTES_FOLDER, exists: true, server: "teams-notes" };
      } catch (err) {
        report.notes =
          err instanceof GraphError && err.status === 404
            ? { folder: NOTES_FOLDER, exists: false, note: "Created on the first save." }
            : { folder: NOTES_FOLDER, error: err.message };
      }
    } else {
      report.notes = { configured: false, note: "M365_TEAMS_NOTES_FOLDER is not set; meeting notes cannot be saved." };
    }
    return text(report);
  },
);

readTool(
  "teams_meetings_list",
  {
    description:
      "List Teams meetings that have a transcript, newest first. Defaults to the last 30 days. A meeting only appears if someone turned on transcription in it. A recurring meeting appears once per occurrence that was transcribed. Use the meetingId and transcriptId with teams_transcript_get.",
    inputSchema: {
      start: z.string().optional().describe("Start of the window, ISO 8601 (e.g. 2026-10-01). Defaults to 30 days before the end."),
      end: z.string().optional().describe("End of the window, ISO 8601. Defaults to now."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum transcripts to return (default 20)."),
    },
  },
  async ({ start, end, limit }) => {
    if (!ORGANIZER) return failed(MEETINGS_OFF);
    return attempt("meetings", async () => {
      const to = end ? new Date(end) : new Date();
      if (Number.isNaN(to.getTime())) return failed(`"${end}" is not a date I can read.`);
      const from = start ? new Date(start) : new Date(to.getTime() - 30 * 864e5);
      if (Number.isNaN(from.getTime())) return failed(`"${start}" is not a date I can read.`);
      if (to <= from) return failed("The end of the window must be after its start.");

      const { items: bulk, more } = await graphAll(
        `${meetingsPath}/getAllTranscripts(meetingOrganizerUserId='${ORGANIZER}',startDateTime=${from.toISOString()},endDateTime=${to.toISOString()})`,
      );
      // Channel meetings come only from the calendar route; the bulk listing
      // covers the rest. The same transcript found both ways counts once.
      const viaCalendar = await calendarTranscripts(from, to);
      const byId = new Map();
      for (const t of [...bulk, ...viaCalendar.items]) if (!byId.has(t.id)) byId.set(t.id, t);
      const items = [...byId.values()];

      // Every transcript is checked against its meeting before it is shown:
      // the subject is what a person recognises, and the meeting's thread is
      // what says whether it is the team's to share.
      const ids = [...new Set(items.map((t) => t.meetingId))];
      const meetings = new Map();
      const problems = [];
      await Promise.all(
        ids.map(async (id) => {
          try {
            meetings.set(id, await meeting(id));
          } catch (err) {
            problems.push(`Could not read meeting ${id.slice(0, 12)}…: ${err.message}`);
          }
        }),
      );

      const visible = items.filter((t) => meetings.has(t.meetingId) && inScope(meetings.get(t.meetingId)));
      const hidden = items.filter((t) => meetings.has(t.meetingId) && !inScope(meetings.get(t.meetingId))).length;
      visible.sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime));
      const shown = visible.slice(0, limit ?? 20).map((t) => summariseTranscript(t, meetings.get(t.meetingId)));

      const notes = [
        hidden ? `${hidden} transcript(s) from meetings outside a Teams channel are not shared with agents on this deployment.` : null,
        visible.length > shown.length ? `${visible.length - shown.length} more in this window: raise the limit or narrow the dates.` : null,
        more ? "Graph had more pages than were read; narrow the window to be sure nothing is missed." : null,
        ...problems,
        ...viaCalendar.notes,
      ].filter(Boolean);

      if (shown.length === 0) {
        const s = viaCalendar.seen;
        return text(
          [
            `No transcripts between ${from.toISOString()} and ${to.toISOString()}.`,
            s.calendar
              ? `Looked at ${s.teamsMeetings} Teams meeting(s) on ${s.calendar}'s calendar; ${s.resolved} belong to the organiser and none of those has a transcript in this window.`
              : null,
            "Teams keeps a transcript only when someone turned on transcription in the meeting (or the meeting was set to transcribe automatically). A recording alone is not a transcript.",
            ...notes,
          ].filter(Boolean).join(" "),
        );
      }
      return text({
        window: { from: from.toISOString(), to: to.toISOString(), timezone: TIMEZONE },
        transcripts: shown,
        ...(notes.length ? { notes } : {}),
      });
    });
  },
);

readTool(
  "teams_transcript_get",
  {
    description:
      "Read one meeting transcript as text: one line per speaker turn, with its time from the start of the meeting. Long transcripts come in pages — when the result says there is more, call again with the offset it gives.",
    inputSchema: {
      meetingId: z.string().min(1).describe("The meetingId from teams_meetings_list."),
      transcriptId: z.string().min(1).describe("The transcriptId from teams_meetings_list."),
      offset: z.number().int().min(0).optional().describe("Character offset to continue from (default 0)."),
    },
  },
  async ({ meetingId, transcriptId, offset }) => {
    if (!ORGANIZER) return failed(MEETINGS_OFF);
    return attempt("meetings", async () => {
      // Checked before the content is fetched, so an id the model was never
      // shown cannot reach a private meeting by being guessed or pasted.
      const m = await meeting(meetingId);
      if (!inScope(m)) return failed(OUT_OF_SCOPE);

      const base = `${meetingsPath}/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}`;
      const meta = await graphJson(base);

      // Speaker-attributed by default. A tenant can forbid attribution, and
      // then only the unattributed format is served: fall back to it, and say
      // so, rather than failing a transcript that exists.
      let attributed = true;
      let res;
      try {
        res = await graphFetch(`${base}/content`, { accept: "text/vtt" });
      } catch (err) {
        if (!(err instanceof GraphError && err.innerCode === "SpeakerAttributionNotAllowed")) throw err;
        attributed = false;
        res = await graphFetch(`${base}/content`, { accept: "application/vnd.microsoft.graph.transcript+text" });
      }
      const raw = await res.text();
      const turns = raw.includes("-->") ? vttToTurns(raw) : [];
      const body = turns.length ? turnsToText(turns) : tidy(raw);
      if (!body) return text(`The transcript for "${m.subject}" is empty: transcription was on, but nothing was said.`);

      const speakers = [...new Set(turns.map((t) => t.speaker).filter(Boolean))];
      const { slice, header } = page(body, offset ?? 0);
      return text(
        [
          `Meeting: ${m.subject || "(untitled meeting)"}`,
          `Transcribed: ${localTime(meta.createdDateTime) ?? "unknown"}${meta.endDateTime ? ` to ${localTime(meta.endDateTime)}` : ""} (${TIMEZONE})`,
          attributed
            ? `Speakers: ${speakers.length ? speakers.join(", ") : "none labelled"}`
            : "Speakers: not available — this tenant has turned off speaker attribution for transcripts.",
          header,
          "",
          slice,
        ]
          .filter((l) => l !== null)
          .join("\n"),
      );
    });
  },
);

readTool(
  "teams_files_list",
  {
    description:
      "List what is in a folder of the team's files (the Files tab in Teams). Each channel has a folder named after it. Folders come first. Leave `path` empty for the top level.",
    inputSchema: {
      path: z.string().optional().describe('Folder path from the top of the team\'s files, e.g. "Meetings" or "General/Contracts". Empty for the top level.'),
    },
  },
  async ({ path }) => {
    if (!SITE) return failed(FILES_OFF);
    return attempt("files", async () => {
      const d = await drive();
      const enc = encodePath(path);
      const target = enc ? `/drives/${d.id}/root:/${enc}:/children` : `/drives/${d.id}/root/children`;
      const { items, more } = await graphAll(target, { $select: ITEM_FIELDS, $top: 200 }, { max: 1000, pages: 5 });
      const where = enc ? decodeURIComponent(enc) : "the top level";
      if (items.length === 0) return text(`Nothing in ${where} of ${d.library}.`);
      items.sort((a, b) => Number(Boolean(b.folder)) - Number(Boolean(a.folder)) || a.name.localeCompare(b.name));
      return text({
        library: `${d.site} / ${d.library}`,
        folder: enc ? decodeURIComponent(enc) : "/",
        count: items.length,
        items: items.map(summariseItem),
        ...(more ? { note: "There are more than 1000 items here; only the first 1000 are listed. Search instead." } : {}),
      });
    });
  },
);

readTool(
  "teams_files_search",
  {
    description:
      "Search the team's files by name and content. Returns matching files and folders with their paths; read one with teams_file_read.",
    inputSchema: {
      query: z.string().min(1).describe('Words to look for, e.g. "budget 2026" or "onboarding".'),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default 25)."),
    },
  },
  async ({ query, limit }) => {
    if (!SITE) return failed(FILES_OFF);
    return attempt("files", async () => {
      const d = await drive();
      const q = encodeURIComponent(query.replace(/'/g, "''"));
      const { items } = await graphAll(
        `/drives/${d.id}/root/search(q='${q}')`,
        { $select: ITEM_FIELDS, $top: limit ?? 25 },
        { max: limit ?? 25, pages: 1 },
      );
      if (items.length === 0) return text(`Nothing in ${d.library} matches "${query}".`);
      return text({ library: `${d.site} / ${d.library}`, searchedFor: query, count: items.length, items: items.map(summariseItem) });
    });
  },
);

readTool(
  "teams_file_read",
  {
    description: `Read a file from the team's files as text. Handles ${READABLE}. Give the itemId from teams_files_list or teams_files_search, or a path. Long files come in pages — when the result says there is more, call again with the offset it gives.`,
    inputSchema: {
      itemId: z.string().optional().describe("The itemId from teams_files_list or teams_files_search."),
      path: z.string().optional().describe('Or the file\'s path, e.g. "Meetings/Agenda.docx". Ignored when itemId is given.'),
      offset: z.number().int().min(0).optional().describe("Character offset to continue from (default 0)."),
    },
  },
  async ({ itemId, path, offset }) => {
    if (!SITE) return failed(FILES_OFF);
    if (!itemId && !encodePath(path)) return failed("Give an itemId or a path.");
    return attempt("files", async () => {
      const d = await drive();
      const item = await graphJson(
        itemId ? `/drives/${d.id}/items/${encodeURIComponent(itemId)}` : `/drives/${d.id}/root:/${encodePath(path)}`,
        { $select: ITEM_FIELDS },
      );
      if (item.folder) return failed(`"${item.name}" is a folder. List it with teams_files_list.`);
      if (typeof item.size === "number" && item.size > MAX_DOWNLOAD) {
        return failed(`"${item.name}" is ${humanSize(item.size)}; files over ${humanSize(MAX_DOWNLOAD)} are not read. Open it in Teams: ${item.webUrl}`);
      }
      const ext = extOf(item.name);
      const supported = canRead(item.name);
      if (!supported) {
        return failed(
          `"${item.name}" is not a file I can read as text (${ext ? `.${ext}` : "no extension"}). I can read ${READABLE}. ` +
            `Old .doc/.xls/.ppt files need saving in the current format first. It is here: ${item.webUrl}`,
        );
      }

      const bytes = new Uint8Array(await (await graphFetch(`/drives/${d.id}/items/${encodeURIComponent(item.id)}/content`)).arrayBuffer());
      let body;
      try {
        body = await fileText(item.name, bytes);
      } catch (err) {
        return failed(`Could not read "${item.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!body) {
        return text(
          `"${item.name}" has no text to read${ext === "pdf" ? " — it is probably scanned pages, which are images" : ""}. It is here: ${item.webUrl}`,
        );
      }
      const { slice, header } = page(body, offset ?? 0);
      return text(
        [
          `File: ${itemPath(item) ?? item.name}`,
          `Modified: ${localTime(item.lastModifiedDateTime) ?? "unknown"}${item.lastModifiedBy?.user?.displayName ? ` by ${item.lastModifiedBy.user.displayName}` : ""}`,
          `Link: ${item.webUrl}`,
          header,
          "",
          slice,
        ]
          .filter((l) => l !== null)
          .join("\n"),
      );
    });
  },
);

// ── meeting notes (the teams-notes server) ───────────────────────────────────
// The layout is code, not a prompt: the agent supplies what was said and
// decided, and every note comes out in the same shape, so a person — or the
// knowledge base — reads the fiftieth like the first.
const oneLine = (s) => String(s).replace(/\s*\n\s*/g, " ").trim();

function localDate(iso) {
  // en-CA formats as YYYY-MM-DD, which sorts in a folder listing.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function safeFileName(s) {
  const name = oneLine(s).replace(/["*:<>?/\\|#%\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/[ .]+$/, "").trim();
  return name.slice(0, 120) || "Meeting";
}

function renderNote({ subject, date, meta, meetingId, transcriptId, summary, attendees, decisions, actions, openQuestions }) {
  const at = (stamp) => (stamp ? ` _(${oneLine(stamp)})_` : "");
  const heading = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, day: "numeric", month: "short", year: "numeric" }).format(
    new Date(meta.createdDateTime),
  );
  const lines = [
    "---",
    `meeting: ${JSON.stringify(subject)}`,
    `date: ${date}`,
    `transcribed: ${JSON.stringify(`${localTime(meta.createdDateTime)}${meta.endDateTime ? ` to ${localTime(meta.endDateTime)}` : ""} (${TIMEZONE})`)}`,
    `meetingId: ${JSON.stringify(meetingId)}`,
    `transcriptId: ${JSON.stringify(transcriptId)}`,
    `written_by: "AI Hub agent, from the Teams transcript"`,
    "---",
    "",
    `# ${oneLine(subject)} — ${heading}`,
    "",
    "_Written by an agent from the meeting transcript. Check it against the transcript before relying on it._",
    "",
    `**Attendees:** ${attendees?.length ? attendees.map(oneLine).join(", ") : "not recorded"}`,
    "",
    "## Summary",
    "",
    summary.trim(),
    "",
    "## Decisions",
    "",
    ...(decisions?.length ? decisions.map((d, i) => `${i + 1}. ${oneLine(d.decision)}${at(d.at)}`) : ["None recorded."]),
    "",
    "## Actions",
    "",
    ...(actions?.length
      ? actions.map(
          (a) =>
            `- [ ] ${oneLine(a.action)}` +
            `${a.owner ? ` — **${oneLine(a.owner)}**` : " — owner not stated"}` +
            `${a.due ? `, due ${oneLine(a.due)}` : ""}${at(a.at)}`,
        )
      : ["None recorded."]),
    "",
    "## Open questions",
    "",
    ...(openQuestions?.length ? openQuestions.map((q) => `- ${oneLine(q)}`) : ["None recorded."]),
    "",
  ];
  return lines.join("\n");
}

/** Creates the configured folder path where it is missing. Never any other. */
async function ensureNotesFolder(d) {
  let parent = "";
  for (const segment of NOTES_SEGMENTS) {
    const here = parent ? `${parent}/${segment}` : segment;
    let exists = true;
    try {
      const item = await graphJson(`/drives/${d.id}/root:/${encodePath(here)}`, { $select: "id,folder" });
      if (!item.folder) throw new Error(`"${here}" exists but is a file, not a folder. Notes cannot be saved there.`);
    } catch (err) {
      if (!(err instanceof GraphError && err.status === 404)) throw err;
      exists = false;
    }
    if (!exists) {
      const target = parent ? `/drives/${d.id}/root:/${encodePath(parent)}:/children` : `/drives/${d.id}/root/children`;
      try {
        await graphFetch(target, {
          method: "POST",
          json: { name: segment, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
        });
      } catch (err) {
        // 409: someone created it in the meantime, which is what we wanted.
        if (!(err instanceof GraphError && err.status === 409)) throw err;
      }
    }
    parent = here;
  }
}

/**
 * Uploads a NEW file, or throws a 409 GraphError if the name is taken.
 *
 * An upload session rather than a plain PUT, because the session documents
 * `conflictBehavior: "fail"`: Graph itself refuses to replace an existing file,
 * so "create-only" does not rest on this code getting a name check right.
 */
async function createNewFile(d, name, body) {
  const bytes = new TextEncoder().encode(body);
  const session = await (
    await graphFetch(`/drives/${d.id}/root:/${encodePath(`${NOTES_FOLDER}/${name}`)}:/createUploadSession`, {
      method: "POST",
      json: { item: { "@microsoft.graph.conflictBehavior": "fail" } },
    })
  ).json();
  // The upload URL is pre-authorised and served by SharePoint, not Graph.
  // Microsoft says not to send the token there, so it is a bare fetch.
  const res = await fetch(session.uploadUrl, {
    method: "PUT",
    headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
    body: bytes,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = out.error ?? {};
    throw new GraphError(res.status, err.code, err.innerError?.code, err.message);
  }
  return out;
}

notesTool(
  "teams_notes_save",
  {
    description:
      `Save the notes for one transcribed Teams meeting as a NEW Markdown file in the team's "${NOTES_FOLDER}" folder, ` +
      "named by the meeting's date and subject. Read the whole transcript with teams_transcript_get first. You supply " +
      "the content; the layout is fixed (summary, decisions, actions with owners, open questions). It never changes an " +
      "existing file: saving again for the same meeting creates a second one, \"… (2).md\". Returns the file's link.",
    inputSchema: {
      meetingId: z.string().min(1).describe("The meetingId from teams_meetings_list."),
      transcriptId: z.string().min(1).describe("The transcriptId from teams_meetings_list."),
      summary: z.string().min(1).max(4000).describe("What the meeting was about and what came of it: one or two short paragraphs."),
      attendees: z
        .array(z.string().min(1))
        .optional()
        .describe("Who took part, by real name. Teams speaker labels can be wrong; correct them from what is said."),
      decisions: z
        .array(
          z.object({
            decision: z.string().min(1).describe("What was decided, as a statement."),
            at: z.string().optional().describe("Transcript time it was decided, e.g. 00:12:04."),
          }),
        )
        .optional(),
      actions: z
        .array(
          z.object({
            action: z.string().min(1).describe("What is to be done."),
            owner: z.string().optional().describe("Who will do it — only if the transcript says so."),
            due: z.string().optional().describe("When — only if the transcript says so."),
            at: z.string().optional().describe("Transcript time it was agreed, e.g. 00:31:10."),
          }),
        )
        .optional(),
      openQuestions: z.array(z.string().min(1)).optional().describe("What was raised but not settled."),
    },
  },
  async ({ meetingId, transcriptId, ...content }) =>
    attempt("notes", async () => {
      // Same scope rule as reading: a note is a summary of the transcript, so a
      // meeting an agent may not read is a meeting it may not write up.
      const m = await meeting(meetingId);
      if (!inScope(m)) return failed(OUT_OF_SCOPE);
      const meta = await graphJson(
        `${meetingsPath}/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}`,
      );

      const subject = m.subject || "Untitled meeting";
      const date = localDate(meta.createdDateTime);
      const body = renderNote({ subject, date, meta, meetingId, transcriptId, ...content });

      const d = await drive();
      await ensureNotesFolder(d);
      const base = `${date} ${safeFileName(subject)}`;
      for (let n = 1; n <= 20; n++) {
        const name = n === 1 ? `${base}.md` : `${base} (${n}).md`;
        try {
          const item = await createNewFile(d, name, body);
          return text({
            saved: `${NOTES_FOLDER}/${name}`,
            webUrl: item.webUrl ?? null,
            itemId: item.id ?? null,
            ...(n > 1 ? { note: `Notes for this meeting already existed, so this is a new file beside them; nothing existing was changed.` } : {}),
          });
        } catch (err) {
          if (!(err instanceof GraphError && err.status === 409)) throw err;
        }
      }
      return failed(`There are already 20 notes named "${base}…" in ${NOTES_FOLDER}. Tidy the folder before saving another.`);
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
