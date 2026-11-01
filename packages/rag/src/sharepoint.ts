import { builtinServerConfig, connectMcpServers, type ConnectedMcp } from "@ai-hub/mcp";
import { registerSourceFamily, type KnowledgeSource, type SourceItem, type SourceListing } from "./sources";

// ── The shared folders ──────────────────────────────────────────────────────
//
// The firm's documents live in the team's SharePoint library (the Files tab in
// Teams, synced to each laptop by OneDrive). This keeps chosen folders of it
// indexed, each into a collection of its own, so a file dropped in a folder is
// something an agent can find an hour later without anyone filing it.
//
//   HUB_SHAREPOINT_FOLDERS='{
//     "company": { "folder": "Company", "collection": "company", "visibility": "restricted" },
//     "clients": { "folder": "Clients", "perFolder": "client-" },
//     "sales":   { "folder": "Sales",   "collection": "sales",   "visibility": "open" }
//   }'
//
// Each entry is a source of type `sharepoint:<key>`, synced every
// HUB_SHAREPOINT_SYNC_MINUTES (default 60; 0 = only by hand). See
// docs/shared-folders.md for Teqneo's tree and who may read what.
//
// What it rests on, and what fences it:
//
// - Reading goes through the read-only `teams` server — the same Graph code
//   and the same Sites.Selected grant the agents use — so this adds no
//   credential and no reach. It cannot write to SharePoint; nothing here can.
// - Visibility fails closed. An entry that does not say "open" is restricted,
//   and a `perFolder` entry (one collection per subfolder: one per client) is
//   restricted whatever it says, because two clients' material in one open
//   drawer is the leak the per-client folders exist to prevent. The collection
//   row is created before the first file is filed, and an existing row is never
//   changed: what a person set on /admin stands.
// - The index follows the folder. A file deleted or moved out is deleted from
//   the index on the next sync, which is why a listing that could not see
//   everything (Graph's 1000-item page cap, too deep a tree) fails the sync
//   instead of returning part of it.
// - A folder another entry syncs, and the meeting-notes folder (its own
//   source, `teams-notes`), are left to their owner, so nothing is indexed
//   twice into two collections with two visibilities.

interface FolderEntry {
  folder: string;
  /** One collection for everything under the folder. */
  collection?: string;
  /** Or: each direct subfolder its own collection, named prefix + the subfolder's slug. */
  perFolder?: string;
  visibility: "open" | "restricted";
  label?: string;
}

/** What `teams_file_read` can turn into text — the server's own list. */
const READABLE = /\.(docx|pptx|xlsx|pdf|vtt|html?|txt|md|markdown|csv|tsv|json|log|xml|ya?ml|ini)$/i;

/** A folder tree deeper than this is an archive someone dropped in, not a drawer. */
const MAX_DEPTH = 8;
/** Per source. Past this the embedding bill and the sync time stop being small. */
const MAX_FILES = 2000;
/** teams_file_read pages at 60,000 characters; this bounds one file at 1.2M. */
const MAX_PAGES = 20;

const COLLECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const SHAREPOINT_SYNC_MINUTES_DEFAULT = 60;

function syncMinutes(): number | undefined {
  const raw = process.env.HUB_SHAREPOINT_SYNC_MINUTES?.trim();
  if (!raw) return SHAREPOINT_SYNC_MINUTES_DEFAULT;
  const n = Number(raw);
  // Anything unreadable falls back to the default rather than to "never",
  // because a sync that silently stopped is the failure nobody notices.
  if (!Number.isFinite(n) || n < 0) return SHAREPOINT_SYNC_MINUTES_DEFAULT;
  return n === 0 ? undefined : Math.max(5, Math.round(n));
}

/** "Clients/" → "Clients"; refuses ".." so a folder cannot reach outside the library's tree. */
function cleanFolder(path: string): string | null {
  const segments = path.split("/").map((s) => s.trim()).filter(Boolean);
  if (!segments.length || segments.some((s) => s === "." || s === "..")) return null;
  return segments.join("/");
}

/** "Møller & Co. ApS" → "moeller-co-aps": a collection name a person can still read. */
export function folderSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function loadSharepointFolders(): Record<string, FolderEntry> {
  const raw = process.env.HUB_SHAREPOINT_FOLDERS;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[rag] HUB_SHAREPOINT_FOLDERS is not valid JSON — no SharePoint folders are synced.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[rag] HUB_SHAREPOINT_FOLDERS must be an object of folders — none are synced.");
    return {};
  }
  const out: Record<string, FolderEntry> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const e = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const folder = typeof e.folder === "string" ? cleanFolder(e.folder) : null;
    const collection = typeof e.collection === "string" ? e.collection.trim() : "";
    const perFolder = typeof e.perFolder === "string" ? e.perFolder.trim() : "";
    // An entry that is wrong is dropped whole and said, never half-applied:
    // a typo'd collection name must not quietly become a new open drawer.
    const problem =
      !/^[a-z0-9_-]+$/i.test(key) ? "its key may only hold letters, digits, - and _"
      : !folder ? 'it needs a "folder" without ".."'
      : Boolean(collection) === Boolean(perFolder) ? 'it needs exactly one of "collection" or "perFolder"'
      : collection && !COLLECTION_NAME.test(collection) ? `"${collection}" is not a collection name (lowercase letters, digits, - and _)`
      : perFolder && !/^[a-z0-9][a-z0-9_-]{0,13}$/.test(perFolder) ? `"${perFolder}" is not a collection prefix (lowercase, at most 14 characters)`
      : null;
    if (problem) {
      console.warn(`[rag] HUB_SHAREPOINT_FOLDERS: "${key}" is ignored — ${problem}.`);
      continue;
    }
    out[key] = {
      folder: folder!,
      ...(collection ? { collection } : { perFolder }),
      visibility: !perFolder && e.visibility === "open" ? "open" : "restricted",
      ...(typeof e.label === "string" && e.label.trim() ? { label: e.label.trim() } : {}),
    };
  }
  return out;
}

interface ListedItem {
  itemId: string;
  name: string;
  kind: "file" | "folder";
  size?: string | null;
  path?: string | null;
  modified?: string | null;
  modifiedAt?: string | null;
  modifiedBy?: string | null;
  webUrl?: string | null;
}

/** teams_file_read answers with a few header lines, a blank line, then the text. */
function fileBody(answer: string): string {
  const at = answer.indexOf("\n\n");
  return at < 0 ? "" : answer.slice(at + 2);
}

async function listFolder(mcp: ConnectedMcp, path: string): Promise<ListedItem[] | "missing"> {
  const answer = await mcp.execute("teams_files_list", { path });
  if (answer.startsWith("Nothing in")) return [];
  if (answer.startsWith("Tool error:")) {
    if (/itemNotFound|404|could not be found/i.test(answer)) return "missing";
    throw new Error(`Could not list ${path}: ${answer.replace(/^Tool error:\s*/, "").split("\n")[0]}`);
  }
  const parsed = JSON.parse(answer) as { items?: ListedItem[]; note?: string };
  if (parsed.note) throw new Error(`${path} has more items than one listing returns; split it into subfolders. (${parsed.note})`);
  return parsed.items ?? [];
}

export function sharepointFolderSource(
  key: string,
  entry: FolderEntry,
  others: { folders: string[]; notesFolder: string },
): KnowledgeSource {
  const configured = Boolean(
    process.env.M365_TEAMS_SITE_URL &&
      process.env.M365_TENANT_ID &&
      process.env.M365_CLIENT_ID &&
      process.env.M365_CLIENT_SECRET,
  );
  const type = `sharepoint:${key}`;
  const lower = (p: string) => p.toLowerCase();
  // Folders that belong to another source: another entry's (only when it is
  // inside this one) and the meeting notes'.
  const excluded = [...others.folders, others.notesFolder]
    .filter(Boolean)
    .map(lower)
    .filter((f) => f !== lower(entry.folder) && f.startsWith(`${lower(entry.folder)}/`));

  return {
    type,
    label: `SharePoint — ${entry.folder}`,
    configured,
    ...(entry.collection ? { defaultCollection: entry.collection } : {}),
    autoSyncMinutes: syncMinutes(),
    async listing(): Promise<SourceListing> {
      if (!configured) {
        throw new Error("SharePoint is not configured. Set M365_TEAMS_SITE_URL and the M365_* app credentials (docs/teams.md).");
      }
      const mcp = await connectMcpServers([builtinServerConfig("teams")!]);
      try {
        const items: SourceItem[] = [];
        const skipped: { path: string; reason: string }[] = [];
        const collections = new Map<string, { name: string; visibility: "open" | "restricted"; label?: string }>();
        if (entry.collection) {
          collections.set(entry.collection, { name: entry.collection, visibility: entry.visibility, label: entry.label ?? entry.folder });
        }
        const slugOwners = new Map<string, string>();

        const fileItem = (f: ListedItem, collection: string): SourceItem => {
          const path = f.path ?? `${entry.folder}/${f.name}`;
          const where = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          const title = `${f.name}${where ? ` — ${where}` : ""}`;
          return {
            externalId: `${type}:${f.itemId}`,
            title,
            // modifiedAt is exact; the size catches the rare save that keeps
            // the timestamp. Older servers without modifiedAt fall back to the
            // minute-rounded time.
            version: `${f.modifiedAt ?? f.modified ?? ""}|${f.size ?? ""}`,
            collection,
            metadata: { path, url: f.webUrl ?? undefined, modified: f.modified ?? undefined, modifiedBy: f.modifiedBy ?? undefined },
            async read() {
              let content = "";
              let offset = 0;
              for (let page = 0; page < MAX_PAGES; page++) {
                const answer = await mcp.execute("teams_file_read", { itemId: f.itemId, ...(offset ? { offset } : {}) });
                if (answer.startsWith("Tool error:")) return { skipped: answer.replace(/^Tool error:\s*/, "").split("\n")[0] };
                content += fileBody(answer);
                const next = answer.match(/call again with offset=(\d+)/);
                if (!next) {
                  offset = -1;
                  break;
                }
                offset = Number(next[1]);
              }
              // Half a contract indexed as the whole of it is worse than none.
              if (offset !== -1) return { skipped: `longer than ${MAX_PAGES} pages of text; split it to index it` };
              if (!content.trim()) return { skipped: "no text to read (a scan is pictures of pages)" };
              // The path rides in the body because chunks are retrieved without
              // their title, and "Proposal v2" alone does not say whose.
              return { content: `${path}\n\n${content}` };
            },
          };
        };

        let files = 0;
        const walk = async (path: string, depth: number, collection: string | null): Promise<void> => {
          const listed = await listFolder(mcp, path);
          if (listed === "missing") {
            // The top folder not existing yet is a state, not an error: it is
            // reported, and whatever was indexed from it is removed.
            if (depth === 0) skipped.push({ path, reason: "the folder does not exist yet" });
            else throw new Error(`${path} disappeared while it was being read; sync again.`);
            return;
          }
          for (const f of listed) {
            const childPath = f.path ?? `${path}/${f.name}`;
            if (f.kind === "folder") {
              if (excluded.includes(lower(childPath))) continue; // its own source indexes it
              if (depth + 1 > MAX_DEPTH) throw new Error(`${childPath} is more than ${MAX_DEPTH} folders deep; flatten it or sync a folder below it.`);
              let into = collection;
              if (entry.perFolder && depth === 0) {
                const slug = folderSlug(f.name);
                const name = `${entry.perFolder}${slug}`;
                if (!slug || !COLLECTION_NAME.test(name)) {
                  skipped.push({ path: childPath, reason: "its name makes no collection name; rename the folder" });
                  continue;
                }
                const owner = slugOwners.get(name);
                if (owner) {
                  skipped.push({ path: childPath, reason: `its collection name ${name} is already ${owner}'s; rename one of them` });
                  continue;
                }
                slugOwners.set(name, childPath);
                collections.set(name, { name, visibility: "restricted", label: f.name });
                into = name;
              }
              await walk(childPath, depth + 1, into);
              continue;
            }
            if (!collection) {
              skipped.push({ path: childPath, reason: `files here belong in one of the folders inside ${entry.folder}` });
              continue;
            }
            if (!READABLE.test(f.name)) {
              const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")).toLowerCase() : "no extension";
              skipped.push({ path: childPath, reason: `not a kind of file the hub reads (${ext})` });
              continue;
            }
            if (++files > MAX_FILES) throw new Error(`${entry.folder} holds more than ${MAX_FILES} files; split it into more than one synced folder.`);
            items.push(fileItem(f, collection));
          }
        };
        await walk(entry.folder, 0, entry.collection ?? null);

        return { items, collections: [...collections.values()], skipped, close: () => mcp.close() };
      } catch (err) {
        await mcp.close();
        throw err;
      }
    },
  };
}

export function sharepointFolderSources(): KnowledgeSource[] {
  const entries = loadSharepointFolders();
  const folders = Object.values(entries).map((e) => e.folder);
  const notesFolder = cleanFolder(process.env.M365_TEAMS_NOTES_FOLDER ?? "") ?? "";
  return Object.entries(entries).map(([key, entry]) => sharepointFolderSource(key, entry, { folders, notesFolder }));
}

registerSourceFamily(sharepointFolderSources);
