import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { addProposalImage, MAX_PROPOSAL_IMAGES, type ProposalImageMeta } from "@ai-hub/db";
import { isLargeArgHandle, resolveLargeArgs } from "@/lib/mcp/largeArgs";

/*
 * Images an agent attaches to a held write, for the approver to look at.
 *
 * An agent cannot draw; it can only point at an image that exists — an https
 * URL it found, or bytes a tool handed it (a screenshot in Claude Code, a
 * file from Teams). So an image arrives as `{ url | data, caption }`, and the
 * hub turns it into stored bytes AT HOLD TIME. The approver then sees what the
 * agent saw, even if the page changes or the link dies before anyone decides.
 *
 * Every image is untrusted, and is treated so on the way in:
 *
 *   - The type is read from the bytes (the magic number), never from a header
 *     or a filename. PNG, JPEG, GIF and WebP only. SVG is refused outright: it
 *     is a document that can carry script, not a picture.
 *   - 5 MB per image, four per proposal.
 *   - A URL is fetched only over https, only to a public address — every
 *     address the name resolves to is checked, and so is every redirect hop
 *     (three at most), so an agent cannot use the hub to read an internal
 *     service or the cloud metadata endpoint. What remains is a DNS answer
 *     that changes between the check and the fetch (rebinding); the response
 *     must still be an image under the cap, and it is only ever shown back to
 *     a person who may see the proposal.
 *
 * A failure never stops the write from being held: the write is what was
 * asked for, the image is supporting evidence. Each failure is reported in
 * words, to the model in the held-call text and so to whoever reads its answer.
 */

export const IMAGES_ARG = "images";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

export const IMAGES_DESCRIPTION =
  "Optional: up to four images the approver should look at before deciding — a screenshot of the finished work, " +
  "the chart or page the change rests on, the thing as it looks now. Give each an https `url` or base64 `data` " +
  "(PNG, JPEG, GIF or WebP, at most 5 MB; a large one may be an @text: handle from hub_put_text), and a `caption` " +
  "saying what it shows. Not sent to the tool.";

/** The JSON Schema for the images argument, as the model sees it on every held tool. */
export const IMAGES_SCHEMA = {
  type: "array",
  maxItems: MAX_PROPOSAL_IMAGES,
  description: IMAGES_DESCRIPTION,
  items: {
    type: "object",
    properties: {
      url: { type: "string", description: "An https URL of the image." },
      data: { type: "string", description: "The image as base64, without a data: prefix (one is tolerated)." },
      caption: { type: "string", description: "What the image shows, in one line." },
    },
  },
} as const;

export interface ImageRequest {
  url?: string;
  data?: string;
  caption?: string;
}

/** The images argument as given, kept to the shape above; anything else is dropped with a note. */
export function readImageRequests(raw: unknown): { requests: ImageRequest[]; notes: string[] } {
  if (raw === undefined || raw === null) return { requests: [], notes: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const notes: string[] = [];
  const requests: ImageRequest[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      notes.push(`Image ${i + 1} was not an object with a url or data, so it was dropped.`);
      return;
    }
    const o = item as Record<string, unknown>;
    const url = typeof o.url === "string" && o.url.trim() ? o.url.trim() : undefined;
    const data = typeof o.data === "string" && o.data.trim() ? o.data.trim() : undefined;
    const caption = typeof o.caption === "string" && o.caption.trim() ? o.caption.trim().slice(0, 300) : undefined;
    if (!url && !data) {
      notes.push(`Image ${i + 1}${caption ? ` ("${caption}")` : ""} had neither a url nor data, so it was dropped.`);
      return;
    }
    requests.push({ url, data, caption });
  });
  if (requests.length > MAX_PROPOSAL_IMAGES) {
    notes.push(`Only the first ${MAX_PROPOSAL_IMAGES} images were kept; ${requests.length - MAX_PROPOSAL_IMAGES} more were dropped.`);
    requests.length = MAX_PROPOSAL_IMAGES;
  }
  return { requests, notes };
}

/** The image type the bytes say they are, or null. Never trusts a header. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/**
 * Whether an address is one the hub must never fetch from on an agent's
 * behalf: loopback, private, link-local (the cloud metadata service lives
 * there), carrier-grade NAT, multicast, reserved, and their IPv6 equivalents,
 * including IPv4 mapped into IPv6.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      x === "::" || x === "::1" ||
      x.startsWith("fc") || x.startsWith("fd") || // unique local
      /^fe[89ab]/.test(x) || // link-local
      x.startsWith("ff") // multicast
    );
  }
  return true; // not an address at all: refuse
}

/** Refuse a URL the hub must not fetch, in words; null when it may. */
export async function urlRefusal(raw: string, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (u.protocol !== "https:") return "is not https";
  if (u.username || u.password) return "carries credentials";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return `names a host that does not resolve (${host})`;
  }
  if (!addresses.length) return `names a host that does not resolve (${host})`;
  if (addresses.some(isPrivateAddress)) return `points at a private or internal address (${host})`;
  return null;
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Fetch an image over https from a public address, following at most three checked redirects. */
export async function fetchImage(
  raw: string,
  opts: { fetcher?: Fetcher; resolve?: (host: string) => Promise<string[]> } = {},
): Promise<{ bytes: Uint8Array; mediaType: string; source: string } | { error: string }> {
  const fetcher = opts.fetcher ?? fetch;
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const refusal = await urlRefusal(url, opts.resolve);
    if (refusal) return { error: `the URL ${refusal}` };
    let res: Response;
    try {
      res = await fetcher(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "image/png,image/jpeg,image/gif,image/webp" },
      });
    } catch (e) {
      return { error: `the URL could not be fetched (${e instanceof Error ? e.message : String(e)})` };
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { error: `the URL redirected (${res.status}) without saying where` };
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok) return { error: `the URL answered ${res.status}` };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) return { error: `the image is ${mb(declared)}, over the 5 MB limit` };
    const bytes = await readCapped(res);
    if ("error" in bytes) return bytes;
    const mediaType = sniffImage(bytes.value);
    if (!mediaType) return { error: "what the URL returned is not a PNG, JPEG, GIF or WebP image" };
    return { bytes: bytes.value, mediaType, source: url };
  }
  return { error: `the URL redirected more than ${MAX_REDIRECTS} times` };
}

/** Read a body, stopping at the cap rather than trusting Content-Length. */
async function readCapped(res: Response): Promise<{ value: Uint8Array } | { error: string }> {
  if (!res.body) return { value: new Uint8Array(await res.arrayBuffer()) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      return { error: "the image is over the 5 MB limit" };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { value: out };
}

/** Decode base64 image data (a data: prefix and whitespace tolerated), and check what it is. */
export function decodeImage(data: string): { bytes: Uint8Array; mediaType: string } | { error: string } {
  const body = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body)) return { error: "the data is not base64" };
  // A rough size check before decoding, so an oversized payload is refused cheaply.
  if (Math.floor((body.length * 3) / 4) > MAX_IMAGE_BYTES) return { error: "the image is over the 5 MB limit" };
  const bytes = new Uint8Array(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  if (!bytes.length) return { error: "the data is empty" };
  const mediaType = sniffImage(bytes);
  if (!mediaType) return { error: "the data is not a PNG, JPEG, GIF or WebP image" };
  return { bytes, mediaType };
}

export interface AttachOutcome {
  attached: ProposalImageMeta[];
  notes: string[];
}

/**
 * Resolve image requests to bytes and store them on a proposal. `principalId`
 * resolves @text: handles, which are scoped to whoever uploaded them.
 */
export async function attachImages(
  proposalId: string,
  requests: ImageRequest[],
  principalId: string | null,
  opts: { fetcher?: Fetcher; resolve?: (host: string) => Promise<string[]> } = {},
): Promise<AttachOutcome> {
  const out: AttachOutcome = { attached: [], notes: [] };
  for (const [i, r] of requests.entries()) {
    const label = `Image ${i + 1}${r.caption ? ` ("${r.caption}")` : ""}`;
    let got: { bytes: Uint8Array; mediaType: string; source?: string } | { error: string };
    if (r.data) {
      let data = r.data;
      if (isLargeArgHandle(data)) {
        if (!principalId) {
          out.notes.push(`${label} was not attached: an @text: handle needs a signed-in caller.`);
          continue;
        }
        const res = resolveLargeArgs(principalId, { data });
        if ("error" in res) {
          out.notes.push(`${label} was not attached: ${res.error}`);
          continue;
        }
        data = String(res.args.data);
      }
      got = decodeImage(data);
    } else {
      got = await fetchImage(r.url!, opts);
    }
    if ("error" in got) {
      out.notes.push(`${label} was not attached: ${got.error}.`);
      continue;
    }
    const stored = await addProposalImage(proposalId, {
      mediaType: got.mediaType,
      bytes: got.bytes,
      caption: r.caption ?? null,
      source: got.source ?? "inline",
    });
    if ("error" in stored) out.notes.push(`${label} was not attached: ${stored.error}`);
    else out.attached.push(stored);
  }
  return out;
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
