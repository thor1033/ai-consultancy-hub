// Verification of the `teams` MCP server — meeting transcripts and the team's
// files, read-only.
//
//   node packages/mcp/verify-teams.mjs
//
// No Microsoft tenant, no app registration, no database. A throwaway HTTP
// server stands in for login.microsoftonline.com and graph.microsoft.com, and
// the real server is pointed at it with M365_LOGIN_BASE_URL /
// M365_GRAPH_BASE_URL. The files it serves are real: a .docx, .pptx and .xlsx
// zipped here with fflate and a PDF written byte by byte, so the text
// extraction is exercised on the formats themselves, not on mocks of them.
//
// What it cannot prove: that Microsoft's live responses match the documented
// shapes this fixture copies (getAllTranscripts, callTranscript, the VTT
// content, driveItem), or that a tenant's access policy and Sites.Selected
// grant are in place. teams_status is the check for those, run against the
// real tenant once it is configured.
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const TENANT = "test-tenant-id";
const CLIENT_SECRET = "test-client-secret";
const ACCESS_TOKEN = "fixture-access-token";
const ORGANIZER = "8b081ef6-4792-4def-b2c9-c363a1bf41d5";
const SITE_HOST = "teqneo.example.com";

// ── fixture: meetings ────────────────────────────────────────────────────────
// One recurring channel meeting transcribed twice (same meetingId, as Teams
// does for a series), one private meeting, one meeting whose tenant forbids
// speaker attribution, and one long enough to need paging.
const MEETINGS = {
  "mtg-checkin": { subject: "Teqneo Check-In", chatInfo: { threadId: "19:abc123@thread.tacv2" } },
  "mtg-private": { subject: "Salary talk", chatInfo: { threadId: "19:meeting_NjQ2@thread.v2" } },
  "mtg-brief": { subject: "Teqneo PM-tool Weekly Brief", chatInfo: { threadId: "19:def456@thread.tacv2" } },
  "mtg-long": { subject: "Strategy day", chatInfo: { threadId: "19:ghi789@thread.skype" } },
};

const TRANSCRIPTS = [
  { id: "tr-checkin-1", meetingId: "mtg-checkin", createdDateTime: "2026-10-14T18:00:05Z", endDateTime: "2026-10-14T18:41:00Z" },
  { id: "tr-private", meetingId: "mtg-private", createdDateTime: "2026-10-15T09:00:00Z", endDateTime: "2026-10-15T09:20:00Z" },
  { id: "tr-checkin-2", meetingId: "mtg-checkin", createdDateTime: "2026-10-21T18:00:10Z", endDateTime: "2026-10-21T18:47:30Z" },
  { id: "tr-brief", meetingId: "mtg-brief", createdDateTime: "2026-10-18T09:00:00Z", endDateTime: "2026-10-18T09:30:00Z" },
  { id: "tr-long", meetingId: "mtg-long", createdDateTime: "2026-10-10T07:00:00Z", endDateTime: "2026-10-10T15:00:00Z" },
];

const CHECKIN_VTT = `WEBVTT

a1b2c3d4/12-0
00:00:16.246 --> 00:00:19.726
<v Ditlev Brygmann>Shall we start with the PM-tool &amp; the roadmap?</v>

a1b2c3d4/13-0
00:00:20.100 --> 00:00:23.000
<v Ditlev Brygmann>I moved the launch to November.</v>

e5f6/1-0
0:00:24.500 --> 0:00:30.000
<v Thor Simonsen>Agreed. I&#39;ll update the board.</v>
`;

const BRIEF_UNATTRIBUTED = `WEBVTT

00:00:01.000 --> 00:00:04.000
Weekly brief: three tasks closed.
`;

const LONG_VTT =
  "WEBVTT\n\n" +
  Array.from({ length: 900 }, (_, i) => {
    const s = String(i % 60).padStart(2, "0");
    const m = String(Math.floor(i / 60) % 60).padStart(2, "0");
    const who = i % 2 ? "Thor Simonsen" : "Ditlev Brygmann";
    return `00:${m}:${s}.000 --> 00:${m}:${s}.900\n<v ${who}>Point ${i}: ${"we discussed the delivery plan in detail ".repeat(3)}</v>\n`;
  }).join("\n");

// ── fixture: files ───────────────────────────────────────────────────────────
const enc = (s) => strToU8(s);

const DOCX = zipSync({
  "[Content_Types].xml": enc("<Types/>"),
  "word/document.xml": enc(
    `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Onboarding plan</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t xml:space="preserve">Clients get a kickoff </w:t></w:r><w:r><w:t>within 5 days &amp; a plan.</w:t></w:r></w:p>` +
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE \\* MERGEFORMAT</w:instrText></w:r></w:p>` +
      `<w:p><w:r><w:delText>deleted words</w:delText></w:r></w:p>` +
      `<w:tbl><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ditlev</w:t></w:r></w:p></w:tc></w:tr>` +
      `<w:tr><w:tc><w:p><w:r><w:t>Due</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Friday</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
      `</w:body></w:document>`,
  ),
});

// Slide files numbered against deck order on purpose: slide2.xml is first.
const PPTX = zipSync({
  "ppt/presentation.xml": enc(`<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId8"/></p:sldIdLst></p:presentation>`),
  "ppt/_rels/presentation.xml.rels": enc(
    `<Relationships><Relationship Id="rId8" Type="slide" Target="slides/slide1.xml"/><Relationship Id="rId9" Type="slide" Target="slides/slide2.xml"/></Relationships>`,
  ),
  "ppt/slides/slide1.xml": enc(`<p:sld><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:sld>`),
  "ppt/slides/slide2.xml": enc(`<p:sld><a:p><a:r><a:t>Teqneo Q4</a:t></a:r></a:p><a:p><a:r><a:t>Growth &amp; focus</a:t></a:r></a:p></p:sld>`),
});

const XLSX = zipSync({
  "xl/workbook.xml": enc(`<workbook><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  "xl/_rels/workbook.xml.rels": enc(`<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>`),
  "xl/sharedStrings.xml": enc(`<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Hos</t></r><r><t>ting</t></r></si></sst>`),
  "xl/worksheets/sheet1.xml": enc(
    `<worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
      `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c><c r="D2" t="inlineStr"><is><t>monthly</t></is></c></row>` +
      `<row r="3"><c r="A3" s="1"/></row>` +
      `</sheetData></worksheet>`,
  ),
});

// A minimal valid one-page PDF, offsets computed rather than hand-counted.
function makePdf(line) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc(out);
}

const PDF = makePdf("Pricing sheet 2026");

const item = (id, name, parent, extra = {}) => ({
  id,
  name,
  webUrl: `https://${SITE_HOST}/sites/Teqneo/Shared%20Documents/${parent ? `${parent}/` : ""}${name}`,
  lastModifiedDateTime: "2026-10-20T10:00:00Z",
  lastModifiedBy: { user: { displayName: "Ditlev Brygmann" } },
  parentReference: { path: `/drives/drive-1/root:${parent ? `/${parent}` : ""}` },
  ...extra,
});

const FILES = {
  "it-general": item("it-general", "General", "", { folder: { childCount: 0 } }),
  "it-meetings": item("it-meetings", "Meetings", "", { folder: { childCount: 7 } }),
  "it-readme": item("it-readme", "README.md", "", { size: 40, file: {}, body: enc("# Teqneo files\n\nStart here.") }),
  "it-docx": item("it-docx", "Onboarding plan.docx", "Meetings", { size: DOCX.length, file: {}, body: DOCX }),
  "it-pptx": item("it-pptx", "Q4 deck.pptx", "Meetings", { size: PPTX.length, file: {}, body: PPTX }),
  "it-xlsx": item("it-xlsx", "Budget.xlsx", "Meetings", { size: XLSX.length, file: {}, body: XLSX }),
  "it-pdf": item("it-pdf", "Pricing.pdf", "Meetings", { size: PDF.length, file: {}, body: PDF }),
  "it-vtt": item("it-vtt", "Check-In.vtt", "Meetings/Recordings", { size: CHECKIN_VTT.length, file: {}, body: enc(CHECKIN_VTT) }),
  "it-png": item("it-png", "Logo.png", "Meetings", { size: 2048, file: {}, body: new Uint8Array([137, 80, 78, 71]) }),
  "it-huge": item("it-huge", "Recording.mp4", "Meetings", { size: 400 * 1024 ** 2, file: {}, body: new Uint8Array(1) }),
  "it-huge-docx": item("it-huge-docx", "Scans.docx", "Meetings", { size: 100 * 1024 ** 2, file: {}, body: new Uint8Array(1) }),
  "it-locked": item("it-locked", "Locked.docx", "Meetings", { size: 10, file: {} }),
};
const strip = ({ body, ...rest }) => rest;

// ── the throwaway tenant ─────────────────────────────────────────────────────
const requests = [];
let tokenRequests = 0;
let origin = "";

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = decodeURIComponent(url.pathname);
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const graphError = (status, code, message, inner) =>
    json(status, { error: { code, message, ...(inner ? { innerError: { code: inner } } : {}) } });

  if (req.method === "POST" && url.pathname === `/${TENANT}/oauth2/v2.0/token`) {
    tokenRequests++;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    if (form.get("client_secret") !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
    return json(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
  }

  requests.push({ method: req.method, path, query: url.searchParams, accept: req.headers.accept });
  if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
    return graphError(401, "InvalidAuthenticationToken", "Access token is empty.");
  }
  if (req.method !== "GET") return graphError(405, "MethodNotAllowed", "This fixture only reads.");

  // ── onlineMeetings ──
  const base = `/users/${ORGANIZER}/onlineMeetings`;
  if (path.startsWith(`${base}/getAllTranscripts(`)) {
    const from = new Date(path.match(/startDateTime=([^,)]+)/)?.[1]);
    const to = new Date(path.match(/endDateTime=([^,)]+)/)?.[1]);
    if (from.getUTCFullYear() === 2020) {
      // A hostile next page: the token must never be sent off Graph.
      return json(200, { value: [], "@odata.nextLink": "http://attacker.invalid/steal" });
    }
    const all = TRANSCRIPTS.filter((t) => new Date(t.createdDateTime) >= from && new Date(t.createdDateTime) <= to);
    // Two pages, so paging is exercised.
    if (url.searchParams.get("$skiptoken") === "p2") return json(200, { value: all.slice(2) });
    return json(200, {
      value: all.slice(0, 2),
      ...(all.length > 2 ? { "@odata.nextLink": `${origin}${url.pathname}?$skiptoken=p2` } : {}),
    });
  }
  const t = path.match(new RegExp(`^${base}/([^/]+)/transcripts/([^/]+)(/content)?$`));
  if (t) {
    const tr = TRANSCRIPTS.find((x) => x.id === t[2] && x.meetingId === t[1]);
    if (!tr) return graphError(404, "NotFound", "Transcript not found.");
    if (!t[3]) return json(200, tr);
    if (tr.id === "tr-brief") {
      if (req.headers.accept === "text/vtt") {
        return graphError(403, "Forbidden", "Speaker-attributed transcript content is disabled for this tenant.", "SpeakerAttributionNotAllowed");
      }
      res.writeHead(200, { "content-type": "application/vnd.microsoft.graph.transcript+text" });
      return res.end(BRIEF_UNATTRIBUTED);
    }
    res.writeHead(200, { "content-type": "text/vtt" });
    return res.end(tr.id === "tr-long" ? LONG_VTT : CHECKIN_VTT);
  }
  const mm = path.match(new RegExp(`^${base}/([^/]+)$`));
  if (mm) return MEETINGS[mm[1]] ? json(200, { id: mm[1], ...MEETINGS[mm[1]] }) : graphError(404, "NotFound", "No meeting.");
  if (path.startsWith("/users/")) {
    return graphError(403, "Forbidden", "No application access policy found for this app.");
  }

  // ── SharePoint ──
  if (path === `/sites/${SITE_HOST}:/sites/Teqneo`) {
    return json(200, { id: `${SITE_HOST},g1,g2`, displayName: "Teqneo", webUrl: `https://${SITE_HOST}/sites/Teqneo` });
  }
  if (path.startsWith(`/sites/${SITE_HOST}:`)) return graphError(403, "accessDenied", "Access denied.");
  if (path === `/sites/${SITE_HOST},g1,g2/drive`) return json(200, { id: "drive-1", name: "Documents" });

  const children = (parent) => Object.values(FILES).filter((f) => f.parentReference.path === `/drives/drive-1/root:${parent ? `/${parent}` : ""}`);
  if (path === "/drives/drive-1/root/children") return json(200, { value: children("").map(strip) });
  const kids = path.match(/^\/drives\/drive-1\/root:\/(.+):\/children$/);
  if (kids) return json(200, { value: children(kids[1]).map(strip) });
  const search = path.match(/^\/drives\/drive-1\/root\/search\(q='(.*)'\)$/);
  if (search) {
    const q = search[1].replace(/''/g, "'").toLowerCase();
    return json(200, { value: Object.values(FILES).filter((f) => f.name.toLowerCase().includes(q.split(/[\s']/)[0])).map(strip) });
  }
  const byPath = path.match(/^\/drives\/drive-1\/root:\/(.+)$/);
  if (byPath) {
    const f = Object.values(FILES).find((x) => `${x.parentReference.path.replace(/^.*root:\/?/, "")}/${x.name}`.replace(/^\//, "") === byPath[1]);
    return f ? json(200, strip(f)) : graphError(404, "itemNotFound", "The resource could not be found.");
  }
  const it = path.match(/^\/drives\/drive-1\/items\/([^/]+)(\/content)?$/);
  if (it) {
    const f = FILES[it[1]];
    if (!f) return graphError(404, "itemNotFound", "The resource could not be found.");
    if (f.id === "it-locked") return graphError(403, "accessDenied", "Access denied.");
    if (!it[2]) return json(200, strip(f));
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(Buffer.from(f.body));
  }
  return graphError(404, "ResourceNotFound", `No route for ${path}.`);
});

await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${http.address().port}`;

const ENV = {
  M365_TENANT_ID: TENANT,
  M365_CLIENT_ID: "test-client-id",
  M365_CLIENT_SECRET: CLIENT_SECRET,
  M365_TEAMS_ORGANIZER_ID: ORGANIZER,
  M365_TEAMS_SITE_URL: `https://${SITE_HOST}/sites/Teqneo/`,
  M365_LOGIN_BASE_URL: origin,
  M365_GRAPH_BASE_URL: origin,
  M365_TIMEZONE: "Europe/Copenhagen",
};
Object.assign(process.env, ENV);
delete process.env.M365_TEAMS_PRIVATE_MEETINGS;

const { connectMcpServers } = await import("./src/manager.ts");
const { builtinServerConfig, BUILTIN_SERVER_NAMES } = await import("./src/servers.ts");

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const contentRequests = (id) => requests.filter((r) => r.path.endsWith(`/transcripts/${id}/content`));

try {
  // ── startup refusals ───────────────────────────────────────────────────────
  // A misconfigured server must say what is wrong on stderr and exit, so a run
  // fails naming the variable instead of answering "no transcripts".
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, "servers", "teams", "server.mjs");
  const start = (env) => {
    const r = spawnSync(process.execPath, [serverPath], { env: { ...process.env, ...env }, input: "", encoding: "utf8", timeout: 10_000 });
    return { code: r.status, stderr: r.stderr, stdout: r.stdout };
  };
  const noSecret = start({ M365_CLIENT_SECRET: "" });
  check("missing credentials: refuses to start and names them", noSecret.code === 1 && /M365_CLIENT_SECRET/.test(noSecret.stderr), noSecret.stderr.trim());
  const nothing = start({ M365_TEAMS_ORGANIZER_ID: "", M365_TEAMS_SITE_URL: "" });
  check("neither half configured: refuses to start", nothing.code === 1 && /nothing to serve/.test(nothing.stderr), nothing.stderr.trim());
  const upn = start({ M365_TEAMS_ORGANIZER_ID: "ditlev@teqneo.co" });
  check(
    "an organiser given as an email, not an object id: refused with where to find the id",
    upn.code === 1 && /object id/i.test(upn.stderr) && /Object ID/.test(upn.stderr),
    upn.stderr.trim().slice(0, 90),
  );
  const badSite = start({ M365_TEAMS_SITE_URL: "teqneo" });
  check("a site that is not a URL: refused", badSite.code === 1 && /M365_TEAMS_SITE_URL/.test(badSite.stderr));
  check("nothing is ever written to stdout, the protocol channel", [noSecret, nothing, upn, badSite].every((r) => r.stdout === ""));

  // ── connection ─────────────────────────────────────────────────────────────
  check("teams is a built-in server", BUILTIN_SERVER_NAMES.includes("teams"));
  const cfg = builtinServerConfig("teams");
  check("it resolves to the bundled server", cfg?.args[0].endsWith("servers/teams/server.mjs"), cfg?.args[0].split("/").slice(-3).join("/"));

  const mcp = await connectMcpServers([cfg]);
  try {
    const names = mcp.tools.map((t) => t.name).sort();
    check("connects over stdio and lists six tools", names.length === 6, names.join(", "));
    const writeish = names.filter((n) => /upload|write|create|update|delete|move|share|send|put|save/i.test(n));
    check("no tool can upload, change or delete anything", writeish.length === 0, writeish.join(", ") || "read-only");

    const status = parse(await mcp.execute("teams_status", {}));
    check("teams_status: both halves working", status.transcripts?.working === true && status.files?.working === true, JSON.stringify(status).slice(0, 120));
    check("and says what it shares", status.transcripts?.shares === "channel meetings only" && status.files?.site === "Teqneo");

    // ── transcripts: the list ────────────────────────────────────────────────
    const list = parse(await mcp.execute("teams_meetings_list", { start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z" }));
    const ids = list.transcripts?.map((x) => x.transcriptId) ?? [];
    check("lists channel-meeting transcripts across both pages", ids.length === 4, ids.join(", "));
    check(
      "newest first, and a recurring meeting appears once per transcribed occurrence",
      ids[0] === "tr-checkin-2" && ids.includes("tr-checkin-1") && list.transcripts[0].meeting === "Teqneo Check-In",
    );
    check("a private meeting is not listed", !ids.includes("tr-private"));
    check("but it is counted, so its absence is not a silent gap", /1 transcript\(s\) from meetings outside a Teams channel/.test(list.notes?.join(" ") ?? ""), list.notes?.[0]);
    check(
      "each entry carries a local time and a duration",
      /Oct 2026/.test(list.transcripts?.[0].when ?? "") && list.transcripts[0].minutes === 47,
      `${list.transcripts?.[0].when}, ${list.transcripts?.[0].minutes} min`,
    );
    const call = requests.find((r) => r.path.includes("getAllTranscripts(") && r.path.includes("2026-10-01"));
    check(
      "asks Graph for the organiser's transcripts in the window",
      call?.path.includes(`meetingOrganizerUserId='${ORGANIZER}'`) && call.path.includes("startDateTime=2026-10-01T00:00:00.000Z"),
      call?.path.split("/").pop().slice(0, 80),
    );
    check(
      "each meeting is looked up once, however many transcripts it has",
      requests.filter((r) => r.path === `/users/${ORGANIZER}/onlineMeetings/mtg-checkin`).length === 1,
    );

    const limited = parse(await mcp.execute("teams_meetings_list", { start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z", limit: 1 }));
    check("a limit says how many more there are", limited.transcripts?.length === 1 && /3 more/.test(limited.notes?.join(" ") ?? ""));

    const none = await mcp.execute("teams_meetings_list", { start: "2026-01-01T00:00:00Z", end: "2026-01-31T00:00:00Z" });
    check("an empty window says why transcripts may be missing", /No transcripts/.test(none) && /turned on transcription/.test(none), none.slice(0, 60));

    const bad = await mcp.execute("teams_meetings_list", { start: "last week" });
    check("an unreadable date is refused before it reaches Graph", /not a date I can read/.test(bad));

    const before = requests.length;
    const hostile = await mcp.execute("teams_meetings_list", { start: "2020-01-01T00:00:00Z", end: "2020-01-02T00:00:00Z" });
    check(
      "a paging link off Graph is refused, so the token never leaves",
      /Tool error/.test(hostile) && /outside Graph/.test(hostile) && requests.length === before + 1,
      hostile.slice(0, 80),
    );

    // ── transcripts: the content ─────────────────────────────────────────────
    const tr = await mcp.execute("teams_transcript_get", { meetingId: "mtg-checkin", transcriptId: "tr-checkin-2" });
    check("teams_transcript_get names the meeting and the speakers", /Meeting: Teqneo Check-In/.test(tr) && /Speakers: Ditlev Brygmann, Thor Simonsen/.test(tr));
    check(
      "one line per turn: a speaker's consecutive cues are merged",
      /\[00:00:16\] Ditlev Brygmann: Shall we start with the PM-tool & the roadmap\? I moved the launch to November\./.test(tr),
      tr.split("\n").find((l) => l.startsWith("[00:00:16]"))?.slice(0, 70),
    );
    check("entities are decoded and short hours padded", /\[00:00:24\] Thor Simonsen: Agreed\. I'll update the board\./.test(tr));
    check("cue ids and the WEBVTT header are not in the text", !/WEBVTT|a1b2c3d4|-->/.test(tr));
    check("speaker-attributed VTT is what is asked for", contentRequests("tr-checkin-2")[0]?.accept === "text/vtt");

    const brief = await mcp.execute("teams_transcript_get", { meetingId: "mtg-brief", transcriptId: "tr-brief" });
    check(
      "a tenant that forbids speaker attribution: falls back to the unattributed transcript and says so",
      /three tasks closed/.test(brief) && /speaker attribution/.test(brief) && !/Tool error/.test(brief),
      brief.split("\n")[2],
    );
    check(
      "by asking again with the unattributed format",
      contentRequests("tr-brief").map((r) => r.accept).join(" → ") === "text/vtt → application/vnd.microsoft.graph.transcript+text",
    );

    const priv = await mcp.execute("teams_transcript_get", { meetingId: "mtg-private", transcriptId: "tr-private" });
    check("a private meeting's transcript is refused by id too", /Tool error/.test(priv) && /outside a Teams channel/.test(priv));
    check("and its content is never fetched", contentRequests("tr-private").length === 0);

    const p1 = await mcp.execute("teams_transcript_get", { meetingId: "mtg-long", transcriptId: "tr-long" });
    const next = Number(p1.match(/offset=(\d+)/)?.[1]);
    check("a long transcript comes in pages, with the offset to continue from", next > 0 && p1.length < 62_000, `next offset ${next}`);
    let rest = "";
    let offset = next;
    for (let i = 0; i < 5 && offset; i++) {
      const p = await mcp.execute("teams_transcript_get", { meetingId: "mtg-long", transcriptId: "tr-long", offset });
      rest += p.slice(p.indexOf("\n\n") + 2);
      offset = Number(p.match(/call again with offset=(\d+)/)?.[1]) || 0;
    }
    const all = p1.slice(p1.indexOf("\n\n") + 2) + rest;
    check(
      "the pages join up with nothing lost or split mid-line",
      /Point 0:/.test(all) && /Point 899:/.test(all) && all.split("\n").every((l) => /^\[\d\d:\d\d:\d\d\] (Ditlev|Thor)/.test(l)),
      `${all.split("\n").length} turns`,
    );

    const gone = await mcp.execute("teams_transcript_get", { meetingId: "mtg-checkin", transcriptId: "tr-nope" });
    check("a missing transcript is an error with its reason, not a blank answer", /Tool error/.test(gone) && /404/.test(gone) && /expires/.test(gone));

    // ── files ────────────────────────────────────────────────────────────────
    const root = parse(await mcp.execute("teams_files_list", {}));
    check(
      "teams_files_list: the top level, folders first",
      root.items?.map((i) => i.name).join(",") === "General,Meetings,README.md" && root.library === "Teqneo / Documents",
      root.items?.map((i) => i.name).join(", "),
    );
    check(
      "the site is resolved from its URL once, then cached",
      requests.filter((r) => r.path === `/sites/${SITE_HOST}:/sites/Teqneo`).length === 1,
    );

    const folder = parse(await mcp.execute("teams_files_list", { path: "/Meetings/" }));
    check(
      "a channel folder by path, with paths and sizes",
      folder.items?.some((i) => i.path === "Meetings/Budget.xlsx" && i.kind === "file" && i.size),
      `${folder.items?.length} items`,
    );
    const emptyFolder = await mcp.execute("teams_files_list", { path: "General" });
    check("an empty folder says so", /Nothing in General/.test(emptyFolder));

    const found = parse(await mcp.execute("teams_files_search", { query: "budget's" }));
    check("teams_files_search finds by name", found.items?.[0]?.name === "Budget.xlsx", found.items?.map((i) => i.name).join(", "));
    check(
      "a quote in the query is escaped for OData, not passed through",
      requests.some((r) => r.path === "/drives/drive-1/root/search(q='budget''s')"),
    );

    const docx = await mcp.execute("teams_file_read", { itemId: "it-docx" });
    check("a Word file reads as text, headings kept", /# Onboarding plan/.test(docx) && /Clients get a kickoff within 5 days & a plan\./.test(docx), docx.split("\n")[5]);
    check("table rows stay on one line", /Owner \| Ditlev/.test(docx) && /Due \| Friday/.test(docx));
    check("field codes and deleted text are left out", !/MERGEFORMAT|deleted words/.test(docx));
    check("with where it lives and who changed it last", /File: Meetings\/Onboarding plan\.docx/.test(docx) && /by Ditlev Brygmann/.test(docx));

    const pptx = await mcp.execute("teams_file_read", { path: "Meetings/Q4 deck.pptx" });
    check(
      "a deck reads in presentation order, not file order",
      /## Slide 1\nTeqneo Q4\nGrowth & focus/.test(pptx) && /## Slide 2\nNext steps/.test(pptx),
      pptx.split("\n").slice(4, 7).join(" / "),
    );

    const xlsx = await mcp.execute("teams_file_read", { itemId: "it-xlsx" });
    check(
      "a workbook reads sheet by sheet, gaps between columns kept",
      /## Sheet: Budget & plan\nItem \| Cost\nHosting \| 1200 \|  \| monthly/.test(xlsx),
      xlsx.split("\n").slice(4, 7).join(" / "),
    );

    const pdf = await mcp.execute("teams_file_read", { itemId: "it-pdf" });
    check("a PDF's text is extracted", /## Page 1\nPricing sheet 2026/.test(pdf), pdf.split("\n").slice(4, 6).join(" / "));

    const vtt = await mcp.execute("teams_file_read", { itemId: "it-vtt" });
    check("a .vtt in the files reads like a transcript", /\[00:00:24\] Thor Simonsen: Agreed/.test(vtt));

    const md = await mcp.execute("teams_file_read", { path: "README.md" });
    check("plain text reads as is", /# Teqneo files\n\nStart here\./.test(md));

    const png = await mcp.execute("teams_file_read", { itemId: "it-png" });
    check("an image is refused with what can be read instead", /Tool error/.test(png) && /not a file I can read/.test(png) && /\.docx/.test(png));
    const dir = await mcp.execute("teams_file_read", { itemId: "it-meetings" });
    check("a folder is refused, pointing at teams_files_list", /is a folder/.test(dir));
    const huge = await mcp.execute("teams_file_read", { itemId: "it-huge-docx" });
    check("a file over the size limit is refused before download", /files over 30\.0 MB/.test(huge));
    check(
      "no oversized or unreadable file is ever downloaded",
      !requests.some((r) => /items\/(it-huge|it-huge-docx|it-png|it-meetings)\/content/.test(r.path)),
    );
    const locked = await mcp.execute("teams_file_read", { itemId: "it-locked" });
    check("a refused file names the permission to check", /Tool error/.test(locked) && /Sites\.Selected/.test(locked), locked.split("\n")[0]);
    const neither = await mcp.execute("teams_file_read", {});
    check("teams_file_read needs an itemId or a path", /Give an itemId or a path/.test(neither));

    check("every Graph call is a read", requests.every((r) => r.method === "GET"));
    check("the access token is fetched once and reused", tokenRequests === 1, `${tokenRequests} token request(s) for ${requests.length} Graph calls`);
  } finally {
    await mcp.close();
  }

  // ── widening on purpose ────────────────────────────────────────────────────
  process.env.M365_TEAMS_PRIVATE_MEETINGS = "1";
  const wide = await connectMcpServers([builtinServerConfig("teams")]);
  try {
    const list = parse(await wide.execute("teams_meetings_list", { start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z" }));
    check("M365_TEAMS_PRIVATE_MEETINGS=1 includes private meetings", list.transcripts?.some((x) => x.transcriptId === "tr-private" && x.channelMeeting === false));
  } finally {
    await wide.close();
    delete process.env.M365_TEAMS_PRIVATE_MEETINGS;
  }

  // ── one half only ──────────────────────────────────────────────────────────
  process.env.M365_TEAMS_SITE_URL = "";
  const half = await connectMcpServers([builtinServerConfig("teams")]);
  try {
    const files = await half.execute("teams_files_list", {});
    check("with only transcripts set up, file tools say which variable is missing", /Tool error/.test(files) && /M365_TEAMS_SITE_URL/.test(files));
    const st = parse(await half.execute("teams_status", {}));
    check("and teams_status reports that half as off", st.files?.working === false && st.transcripts?.working === true);
  } finally {
    await half.close();
    process.env.M365_TEAMS_SITE_URL = ENV.M365_TEAMS_SITE_URL;
  }
} finally {
  http.close();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(
  failedChecks.length
    ? `\n${failedChecks.length} of ${checks.length} checks FAILED`
    : `\nTeams MCP server OK (${checks.length} checks)`,
);
process.exit(failedChecks.length ? 1 : 0);
