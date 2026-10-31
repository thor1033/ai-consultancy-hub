import { createHash } from "node:crypto";
import { githubTarget, licenseFromText, parseAgentFile, rawUrl, type GithubTarget, type ImportSource, type ParsedAgentFile } from "@ai-hub/db";

/*
 * Fetching an agent file from GitHub for the importer (docs/skill-import.md).
 *
 * The hub fetches from its server, so the pasted address is checked before
 * anything is reached (github.com or raw.githubusercontent.com only, https),
 * the read is bounded (size and time), and what comes back is parsed as data:
 * it becomes a brief only after a person has read the preview and said yes.
 *
 * A folder link is read as the Agent Skills standard says: its SKILL.md. A
 * repository link is its root SKILL.md. A file link is that file. The
 * repository's LICENSE is read when the file names none, best-effort: a
 * missing license is recorded as not found, never guessed.
 */

export const MAX_FILE_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export interface FetchedAgentFile {
  target: GithubTarget;
  source: ImportSource;
  parsed: ParsedAgentFile;
  /** The raw text, for the preview. */
  text: string;
}

export interface FetchOptions {
  /** The raw host, for a test's stand-in. Production uses GitHub's. */
  rawBase?: string;
  fetchImpl?: typeof fetch;
}

async function readText(url: string, fetchImpl: typeof fetch): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "text/plain" }, redirect: "error" });
  if (!res.ok) return { ok: false, status: res.status };
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_FILE_BYTES) throw new Error(`That file is ${Math.round(length / 1024)} KB; the importer reads up to ${MAX_FILE_BYTES / 1024} KB.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new Error(`That file is ${Math.round(buf.length / 1024)} KB; the importer reads up to ${MAX_FILE_BYTES / 1024} KB.`);
  return { ok: true, text: buf.toString("utf8") };
}

export async function fetchAgentFile(input: string, opts: FetchOptions = {}): Promise<FetchedAgentFile | { error: string }> {
  const target = githubTarget(input);
  if ("error" in target) return target;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.rawBase ?? "https://raw.githubusercontent.com";
  const path = target.file ? target.path : target.path ? `${target.path}/SKILL.md` : "SKILL.md";
  if (!/\.md$/i.test(path)) return { error: "The importer reads Markdown agent files: a SKILL.md, or an agent's .md file." };
  const url = rawUrl(target, path, base);
  let read: Awaited<ReturnType<typeof readText>>;
  try {
    read = await readText(url, fetchImpl);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!read.ok) {
    return {
      error:
        read.status === 404
          ? target.file
            ? `GitHub has no file at ${target.path} on ${target.ref} of ${target.repo}.`
            : `No SKILL.md in ${target.path || "the root"} of ${target.repo} (${target.ref}). Paste the link to the agent's .md file instead.`
          : `GitHub answered ${read.status} for ${url}.`,
    };
  }
  const parsed = parseAgentFile(read.text);
  if (!parsed.body) return { error: "The file has no instructions beneath its frontmatter." };
  // The license, when the file names none: a LICENSE beside the file (the
  // standard lets a skill bundle its own; anthropics/skills does, per folder),
  // then the repository's. Read from the same ref; none anywhere is recorded
  // as not found.
  let license = parsed.license;
  if (!license) {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const candidates = ["LICENSE", "LICENSE.txt", "LICENSE.md"];
    const places = [...(folder ? candidates.map((n) => `${folder}/${n}`) : []), ...candidates];
    for (const name of places) {
      try {
        const lic = await readText(rawUrl(target, name, base), fetchImpl);
        if (lic.ok) {
          license = licenseFromText(lic.text) ?? "unrecognised";
          break;
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return {
    target,
    parsed,
    text: read.text,
    source: {
      kind: "github",
      url: input.trim(),
      rawUrl: url,
      repo: target.repo,
      ref: target.ref,
      path,
      license,
      importedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(read.text).digest("hex"),
    },
  };
}
