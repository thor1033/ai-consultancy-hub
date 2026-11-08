// The models an agent can be pinned to. Empty id means the runtime default.
export const MODELS = [
  { id: "", label: "Default", note: "Whatever the hub runs by default" },
  { id: "claude-opus-4-8", label: "Opus", note: "Most capable; slower and costlier. For an agent that plans, delegates or reconciles" },
  { id: "claude-sonnet-4-6", label: "Sonnet", note: "Balanced. Right for a worker, a specialist, a stage or a reviewer — a ready-made team puts those here" },
  { id: "claude-haiku-4-5", label: "Haiku", note: "Fast and cheap. For a bounded job with a short answer" },
];

// Bundled servers that take a per-agent mailbox. Mirrors MAILBOX_SERVER_NAMES
// in @ai-hub/mcp, which this client-safe module cannot import.
export const MAILBOX_SERVERS = new Set(["microsoft365"]);

/** `{ serverName: mailbox }` for every stored entry that names one. */
export const serverMailboxes = (entries: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const name = (e as { name?: unknown })?.name;
    const mailbox = (e as { mailbox?: unknown })?.mailbox;
    if (typeof name === "string" && typeof mailbox === "string" && mailbox.trim()) out[name] = mailbox.trim();
  }
  return out;
};

/** The web entry's bounds, as the form holds them (docs/web.md): sites one per line, searches per run as text. */
export const webEntryValues = (entries: unknown): { webOnly: string; webSearches: string } => {
  const out = { webOnly: "", webSearches: "" };
  if (!Array.isArray(entries)) return out;
  const e = entries.find((x) => (x as { name?: unknown })?.name === "web") as { only?: unknown; searches?: unknown } | undefined;
  if (!e) return out;
  if (Array.isArray(e.only)) out.webOnly = e.only.filter((s) => typeof s === "string").join("\n");
  if (typeof e.searches === "number") out.webSearches = String(e.searches);
  return out;
};

export const serverNames = (entries: unknown): string[] =>
  Array.isArray(entries)
    ? entries
        .map((e) => (typeof e === "string" ? e : String((e as { name?: unknown })?.name ?? "")))
        .filter(Boolean)
    : [];

// The names connected clients see. Mirrors toolNameForAgent / toolNameForSkill
// in lib/mcp/hubServer.ts, which this client-safe module cannot import.
export const agentToolName = (slug: string) => `hub_agent_${slug.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}`;
export const skillToolName = (slug: string) => `hub_skill_${slug.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}`;

/** The servers an agent's entries let write without a person's approval. */
export function serverWritesAllowed(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && typeof e === "object" && (e as { writes?: unknown }).writes === "allow")
    .map((e) => String((e as { name?: unknown }).name ?? ""))
    .filter(Boolean);
}
