// The models an agent can be pinned to. Empty id means the runtime default.
export const MODELS = [
  { id: "", label: "Default", note: "Whatever the hub runs by default" },
  { id: "claude-opus-4-8", label: "Opus", note: "Most capable; slower and costlier" },
  { id: "claude-sonnet-4-6", label: "Sonnet", note: "Balanced" },
  { id: "claude-haiku-4-5", label: "Haiku", note: "Fast and cheap" },
];

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
