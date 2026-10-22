// Verification of the large-argument rule — how a value too big for one tool
// call reaches a skill whole.
//
//   node --experimental-transform-types apps/web/verify-large-args.mjs
//
// No API key, no database, no network: the store and the resolver are pure,
// and the clock is passed in, so expiry is checked against a fixed time rather
// than by waiting an hour. The MCP surface that exposes this (hub_put_text and
// the substitution inside every hub_skill_* call) is exercised by
// verify-agent-tools.mjs, which needs a database.
//
// The check that matters most is the one about incompleteness: a handle with a
// part missing must be refused with the part number, never passed on as the
// shorter text it happens to hold. A silently truncated transcript is the
// failure this mechanism exists to end.
import {
  putTextPart,
  resolveLargeArgs,
  isLargeArgHandle,
  clearLargeArgs,
  LARGE_ARG_PART_CHARS,
  LARGE_ARG_MAX_CHARS,
  LARGE_ARG_TTL_MS,
  LARGE_ARG_RULE,
  HANDLE_PREFIX,
} from "./src/lib/mcp/largeArgs.ts";

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const T0 = 1_700_000_000_000;
const ALICE = "principal-alice";
const BOB = "principal-bob";

/** Splits a string into equal parts of the limit, however many it takes — the rule as a caller would apply it. */
function split(s, size = LARGE_ARG_PART_CHARS) {
  const parts = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts;
}

// A transcript-sized value: 2.3 parts' worth, with a distinctive tail so a
// dropped last part is visible rather than inferred.
const transcript =
  "WEBVTT\n\n" +
  "00:00:04.113 --> 00:00:04.433\n<v Ditlev Brygmann>Og.</v>\n\n".repeat(900) +
  "<v thor_simonsen>THE LAST LINE OF THE MEETING.</v>";
check(
  "the fixture value really is larger than one part",
  transcript.length > 2 * LARGE_ARG_PART_CHARS,
  `${transcript.length} chars, ${split(transcript).length} parts`,
);

// ── the happy path ──────────────────────────────────────────────────────────
clearLargeArgs();
{
  const parts = split(transcript);
  const first = putTextPart(ALICE, { part: 1, parts: parts.length, text: parts[0] }, T0);
  check("the first part opens a handle", !("error" in first) && typeof first.handle === "string", first.handle);
  check("and reports the upload as incomplete, naming what is missing",
    !("error" in first) && first.complete === false && JSON.stringify(first.missing) === JSON.stringify([2, 3]));

  let last;
  for (let i = 1; i < parts.length; i++) {
    last = putTextPart(ALICE, { handle: first.handle, part: i + 1, parts: parts.length, text: parts[i] }, T0);
  }
  check("the final part completes it", !("error" in last) && last.complete === true && last.chars === transcript.length,
    `${last?.chars} chars`);

  const args = { transcript: `${HANDLE_PREFIX}${first.handle}`, meetingDate: "2026-10-03", attendees: "" };
  const resolved = resolveLargeArgs(ALICE, args, T0);
  check("a handle among the arguments is replaced by the whole text", !("error" in resolved) && resolved.args.transcript === transcript);
  check("including its last line — nothing is lost off the end",
    !("error" in resolved) && resolved.args.transcript.endsWith("THE LAST LINE OF THE MEETING.</v>"));
  check("other arguments pass through untouched",
    !("error" in resolved) && resolved.args.meetingDate === "2026-10-03" && resolved.args.attendees === "");
  check("and the result says which arguments were substituted",
    !("error" in resolved) && JSON.stringify(resolved.resolved) === JSON.stringify(["transcript"]));
  check("a handle may be passed with or without its prefix when uploading",
    !("error" in putTextPart(ALICE, { handle: `${HANDLE_PREFIX}${first.handle}`, part: 1, parts: parts.length, text: parts[0] }, T0)));
}

// ── order and retries ───────────────────────────────────────────────────────
clearLargeArgs();
{
  const parts = split(transcript);
  const opened = putTextPart(ALICE, { part: 3, parts: 3, text: parts[2] }, T0);
  putTextPart(ALICE, { handle: opened.handle, part: 1, parts: 3, text: parts[0] }, T0);
  const done = putTextPart(ALICE, { handle: opened.handle, part: 2, parts: 3, text: parts[1] }, T0);
  const resolved = resolveLargeArgs(ALICE, { transcript: `${HANDLE_PREFIX}${opened.handle}` }, T0);
  check("parts may arrive in any order and are joined in theirs",
    done.complete === true && !("error" in resolved) && resolved.args.transcript === transcript);

  const again = putTextPart(ALICE, { handle: opened.handle, part: 2, parts: 3, text: parts[1] }, T0);
  check("re-sending a part (a retried call) overwrites rather than errors or duplicates",
    !("error" in again) && again.complete === true && again.chars === transcript.length);
}

// ── incompleteness is refused, with the part number ─────────────────────────
clearLargeArgs();
{
  const parts = split(transcript);
  const opened = putTextPart(ALICE, { part: 1, parts: 3, text: parts[0] }, T0);
  putTextPart(ALICE, { handle: opened.handle, part: 3, parts: 3, text: parts[2] }, T0);
  const resolved = resolveLargeArgs(ALICE, { transcript: `${HANDLE_PREFIX}${opened.handle}` }, T0);
  check("an upload with a part missing is refused, not passed on shorter",
    "error" in resolved, "error" in resolved ? resolved.error.slice(0, 80) : "resolved!");
  check("and the error names the missing part", "error" in resolved && /part 2 of 3/.test(resolved.error));
}

// ── the size rule itself ────────────────────────────────────────────────────
clearLargeArgs();
{
  const tooBig = putTextPart(ALICE, { part: 1, parts: 1, text: "x".repeat(LARGE_ARG_PART_CHARS + 1) }, T0);
  check("a part over the limit is refused, not trimmed", "error" in tooBig && new RegExp(`${LARGE_ARG_PART_CHARS}`).test(tooBig.error));
  check("and the refusal restates the rule: equal parts, as many as it takes", "error" in tooBig && /equal parts/.test(tooBig.error));
  const exact = putTextPart(ALICE, { part: 1, parts: 1, text: "x".repeat(LARGE_ARG_PART_CHARS) }, T0);
  check("a part exactly at the limit is accepted", !("error" in exact) && exact.complete === true);
  const tooMany = putTextPart(ALICE, { part: 1, parts: LARGE_ARG_MAX_CHARS / LARGE_ARG_PART_CHARS + 1, text: "x" }, T0);
  check("a split into more parts than the total cap allows is refused up front", "error" in tooMany);
  check("the rule text names the limit and the tool, so a caller can follow it from the description alone",
    LARGE_ARG_RULE.includes(String(LARGE_ARG_PART_CHARS)) && LARGE_ARG_RULE.includes("hub_put_text") && LARGE_ARG_RULE.includes(HANDLE_PREFIX));
}

// ── bad part arithmetic ─────────────────────────────────────────────────────
clearLargeArgs();
{
  check("part 0 is refused", "error" in putTextPart(ALICE, { part: 0, parts: 2, text: "a" }, T0));
  check("a part beyond the count is refused", "error" in putTextPart(ALICE, { part: 3, parts: 2, text: "a" }, T0));
  check("zero parts is refused", "error" in putTextPart(ALICE, { part: 1, parts: 0, text: "a" }, T0));
  const opened = putTextPart(ALICE, { part: 1, parts: 2, text: "a" }, T0);
  const changed = putTextPart(ALICE, { handle: opened.handle, part: 2, parts: 3, text: "b" }, T0);
  check("changing the part count mid-upload is refused rather than silently resized", "error" in changed && /Start a new handle/.test(changed.error));
  check("an unknown handle is refused", "error" in putTextPart(ALICE, { handle: "nope", part: 1, parts: 1, text: "a" }, T0));
}

// ── scope ───────────────────────────────────────────────────────────────────
clearLargeArgs();
{
  const mine = putTextPart(ALICE, { part: 1, parts: 1, text: "alice's transcript" }, T0);
  const theirs = resolveLargeArgs(BOB, { transcript: `${HANDLE_PREFIX}${mine.handle}` }, T0);
  check("another principal's handle does not resolve — a handle is a bearer of its text",
    "error" in theirs && /does not exist for you/.test(theirs.error));
  const theirUpload = putTextPart(BOB, { handle: mine.handle, part: 1, parts: 1, text: "overwrite?" }, T0);
  check("nor can another principal add to it", "error" in theirUpload);
  const unknown = resolveLargeArgs(ALICE, { transcript: `${HANDLE_PREFIX}never-opened` }, T0);
  check("an unknown handle in the arguments is a readable error that restates the rule",
    "error" in unknown && unknown.error.includes("hub_put_text"));
}

// ── expiry ──────────────────────────────────────────────────────────────────
clearLargeArgs();
{
  const old = putTextPart(ALICE, { part: 1, parts: 1, text: "stale" }, T0);
  const stillThere = resolveLargeArgs(ALICE, { t: `${HANDLE_PREFIX}${old.handle}` }, T0 + LARGE_ARG_TTL_MS - 1);
  check("an upload is readable right up to its TTL", !("error" in stillThere) && stillThere.args.t === "stale");
  const gone = resolveLargeArgs(ALICE, { t: `${HANDLE_PREFIX}${old.handle}` }, T0 + LARGE_ARG_TTL_MS + 1);
  check("and gone after it, with the error saying it may have expired", "error" in gone && /expired/.test(gone.error));
}

// ── what is NOT a handle ────────────────────────────────────────────────────
clearLargeArgs();
{
  const plain = resolveLargeArgs(ALICE, { transcript: "a short transcript", n: 3, flag: true, nothing: null }, T0);
  check("ordinary values are left exactly as they came", !("error" in plain) && JSON.stringify(plain.args) === JSON.stringify({ transcript: "a short transcript", n: 3, flag: true, nothing: null }) && plain.resolved.length === 0);
  check("the bare prefix is not a handle", !isLargeArgHandle(HANDLE_PREFIX));
  check("a value that merely mentions the prefix mid-text is not a handle", !isLargeArgHandle(`see ${HANDLE_PREFIX}abc`));
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? `\nLarge arguments OK (${checks.length} checks)` : `\nLarge arguments FAILED (${failed.length}/${checks.length})`);
process.exit(failed.length === 0 ? 0 : 1);
