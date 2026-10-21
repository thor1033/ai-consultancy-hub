import { randomBytes } from "node:crypto";

/*
 * Large arguments over MCP — the generic rule.
 *
 * A skill's arguments arrive as a tool call, and a tool call is something the
 * CALLING model has to write out token by token inside one turn. That is the
 * limit the secretary kept hitting: a 45-minute Teams transcript is ~90KB, the
 * orchestrating model (Claude Code, Cursor, whatever) cannot reliably emit that
 * as a single tool argument, and the result is a call that errors or a
 * transcript that arrives with its tail missing. Nothing on the hub side can
 * fix that by accepting more — the hub never sees what the caller could not
 * send.
 *
 * So the rule is on the caller, and it is the same for every string argument of
 * every tool, as Ditlev asked (2026-09-22): when a value is longer than
 * LARGE_ARG_PART_CHARS, split it into equal parts of that size — however many
 * that takes — send each with hub_put_text under one handle, and pass the
 * handle in place of the value. Equal parts, not "split in two": halving only
 * moves the failure to the next longer input. The hub reassembles and
 * substitutes before the skill ever sees the arguments, so a skill template is
 * written exactly as before.
 *
 * Parts live in this process, per principal, for LARGE_ARG_TTL_MS. The hub
 * runs as one Fly machine (fly.toml: min_machines_running = 1, no autoscale),
 * so one process is where every part lands. If that ever changes, this store
 * moves to Postgres — the shape here is the same, only the Map goes.
 */

/** The most a single part may carry. ~5,000 tokens: small enough that any
 * orchestrating model emits it in one go without strain. */
export const LARGE_ARG_PART_CHARS = 20_000;

/** The most one handle may hold in total — 100 parts, about a day of meetings. */
export const LARGE_ARG_MAX_CHARS = LARGE_ARG_PART_CHARS * 100;

/** How long an unfinished or unused upload is kept. */
export const LARGE_ARG_TTL_MS = 60 * 60 * 1000;

/** What a caller passes in place of the value. */
export const HANDLE_PREFIX = "@text:";

/** The rule, worded once, for every tool description that has to state it. */
export const LARGE_ARG_RULE =
  `Any string argument longer than ${LARGE_ARG_PART_CHARS} characters must not be sent ` +
  `inline: split it into equal parts of at most ${LARGE_ARG_PART_CHARS} characters, ` +
  `send each part with hub_put_text under one handle, and pass that handle ` +
  `("${HANDLE_PREFIX}<handle>") as the argument instead.`;

interface Pending {
  principalId: string;
  parts: (string | undefined)[];
  createdAt: number;
}

const store = new Map<string, Pending>();

const keyOf = (principalId: string, handle: string) => `${principalId}\u0000${handle}`;

function sweep(now: number) {
  for (const [key, pending] of store) {
    if (now - pending.createdAt > LARGE_ARG_TTL_MS) store.delete(key);
  }
}

export interface PutTextInput {
  /** Omit on the first part; the result carries the handle to use for the rest. */
  handle?: string;
  /** 1-based index of this part. */
  part: number;
  /** How many parts there are in total. */
  parts: number;
  text: string;
}

export interface PutTextResult {
  handle: string;
  received: number;
  parts: number;
  /** True once every part has arrived and the handle can be passed as an argument. */
  complete: boolean;
  /** Total characters, once complete. */
  chars?: number;
  /** Part numbers still missing, when not complete. */
  missing?: number[];
}

/**
 * Stores one part of a large value and reports how far along the upload is.
 *
 * Parts may arrive in any order and a part may be re-sent (a retried call
 * overwrites, which is what a retry should do). A part over the size limit is
 * refused rather than trimmed — a silently shortened transcript is the failure
 * this whole mechanism exists to prevent.
 */
export function putTextPart(
  principalId: string,
  input: PutTextInput,
  now: number = Date.now(),
): PutTextResult | { error: string } {
  sweep(now);

  const parts = Math.trunc(input.parts);
  const part = Math.trunc(input.part);
  if (!Number.isFinite(parts) || parts < 1) return { error: '"parts" must be a whole number of at least 1.' };
  if (parts * LARGE_ARG_PART_CHARS > LARGE_ARG_MAX_CHARS) {
    return { error: `At most ${LARGE_ARG_MAX_CHARS / LARGE_ARG_PART_CHARS} parts are accepted per handle.` };
  }
  if (!Number.isFinite(part) || part < 1 || part > parts) {
    return { error: `"part" must be between 1 and ${parts}.` };
  }
  if (typeof input.text !== "string") return { error: '"text" must be a string.' };
  if (input.text.length > LARGE_ARG_PART_CHARS) {
    return {
      error:
        `Part ${part} is ${input.text.length} characters; the limit is ${LARGE_ARG_PART_CHARS}. ` +
        `Split the value into equal parts of at most ${LARGE_ARG_PART_CHARS} characters and send each one.`,
    };
  }

  let handle = input.handle?.trim();
  let pending: Pending | undefined;
  if (handle) {
    if (handle.startsWith(HANDLE_PREFIX)) handle = handle.slice(HANDLE_PREFIX.length);
    pending = store.get(keyOf(principalId, handle));
    if (!pending) {
      return { error: `No upload in progress under handle "${handle}" (it may have expired — uploads are kept for an hour).` };
    }
    if (pending.parts.length !== parts) {
      return {
        error: `Handle "${handle}" was opened for ${pending.parts.length} parts; this call says ${parts}. Start a new handle if the split changed.`,
      };
    }
  } else {
    handle = randomBytes(9).toString("base64url");
    pending = { principalId, parts: new Array<string | undefined>(parts).fill(undefined), createdAt: now };
    store.set(keyOf(principalId, handle), pending);
  }

  pending.parts[part - 1] = input.text;
  const missing: number[] = [];
  pending.parts.forEach((p, i) => {
    if (p === undefined) missing.push(i + 1);
  });
  const complete = missing.length === 0;
  return {
    handle,
    received: parts - missing.length,
    parts,
    complete,
    ...(complete
      ? { chars: pending.parts.reduce((n, p) => n + (p?.length ?? 0), 0) }
      : { missing }),
  };
}

/** Whether a value is a handle rather than the value itself. */
export function isLargeArgHandle(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(HANDLE_PREFIX) && value.length > HANDLE_PREFIX.length;
}

/**
 * Replaces every handle among the arguments with the text uploaded under it.
 *
 * Scoped to the principal: a handle is a bearer of its own text, so another
 * principal's handle does not resolve here — the same rule as run ids. An
 * incomplete upload is an error that names the missing parts, never a partial
 * value passed on as if it were whole.
 */
export function resolveLargeArgs(
  principalId: string,
  args: Record<string, unknown>,
  now: number = Date.now(),
): { args: Record<string, unknown>; resolved: string[] } | { error: string } {
  sweep(now);
  const out: Record<string, unknown> = { ...args };
  const resolved: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    if (!isLargeArgHandle(value)) continue;
    const handle = value.slice(HANDLE_PREFIX.length).trim();
    const pending = store.get(keyOf(principalId, handle));
    if (!pending) {
      return {
        error: `"${name}" refers to upload "${handle}", which does not exist for you (it may have expired — uploads are kept for an hour). ${LARGE_ARG_RULE}`,
      };
    }
    const missing = pending.parts.map((p, i) => (p === undefined ? i + 1 : 0)).filter(Boolean);
    if (missing.length) {
      return {
        error: `"${name}" refers to upload "${handle}", which is incomplete: part${missing.length > 1 ? "s" : ""} ${missing.join(", ")} of ${pending.parts.length} never arrived. Send the missing part${missing.length > 1 ? "s" : ""} with hub_put_text and retry.`,
      };
    }
    out[name] = pending.parts.join("");
    resolved.push(name);
  }
  return { args: out, resolved };
}

/** Test seam: forget everything. */
export function clearLargeArgs(): void {
  store.clear();
}
