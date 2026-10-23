import { agentRoster, serverUsage, type AgentRosterRow, type ServerUsage } from "@ai-hub/db";
import { listRegisteredServers, serverConnection, type ServerConnection } from "@/lib/mcpCatalog";
import { knownServers } from "@/lib/runSession";

// Every tool server the hub knows about, joined with who uses it and how much:
// the registry rows (remote servers and anything added by hand) plus the local
// servers the hub starts itself, which have no registry row until someone
// creates one. Memory is left out — it is per agent, and the Context page is
// where it is shown.

export interface ServerUser {
  name: string;
  slug: string;
  enabled: boolean;
}

export interface DirectoryEntry {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  /** Has a row in the control plane, so it can be switched off. */
  inRegistry: boolean;
  connection: ServerConnection;
  users: ServerUser[];
  runs7d: number;
  lastUsedAt: string | null;
}

const LOCAL_DESCRIPTIONS: Record<string, string> = {
  microsoft365: "Read-only Outlook mail and calendar through Microsoft Graph.",
  teams: "Read-only Teams meeting transcripts and the team's SharePoint files.",
};

const LOCAL_LABELS: Record<string, string> = {
  microsoft365: "Microsoft 365",
  teams: "Microsoft Teams",
};

const namesOf = (entries: unknown): string[] =>
  Array.isArray(entries)
    ? entries.map((e) => (typeof e === "string" ? e : String((e as { name?: unknown })?.name ?? ""))).filter(Boolean)
    : [];

export async function serverDirectory(): Promise<{ entries: DirectoryEntry[]; roster: AgentRosterRow[] }> {
  const [rows, roster, usage] = await Promise.all([
    listRegisteredServers(),
    agentRoster().catch(() => [] as AgentRosterRow[]),
    serverUsage(7).catch(() => [] as ServerUsage[]),
  ]);
  const usageBy = new Map(usage.map((u) => [u.name, u]));
  const users = (name: string): ServerUser[] =>
    roster
      .filter((a) => namesOf(a.mcpServers).includes(name))
      .map((a) => ({ name: a.name, slug: a.slug, enabled: a.enabled }));

  const entries: DirectoryEntry[] = rows.map((r) => ({
    name: r.name,
    label: r.label || LOCAL_LABELS[r.name] || r.name,
    description: r.description || LOCAL_DESCRIPTIONS[r.name] || "",
    enabled: r.enabled,
    inRegistry: true,
    connection: serverConnection(r.name),
    users: users(r.name),
    runs7d: usageBy.get(r.name)?.runs ?? 0,
    lastUsedAt: usageBy.get(r.name)?.lastUsedAt ?? null,
  }));
  const listed = new Set(entries.map((e) => e.name));
  for (const name of knownServers()) {
    if (name === "memory" || listed.has(name)) continue;
    entries.push({
      name,
      label: LOCAL_LABELS[name] ?? name,
      description: LOCAL_DESCRIPTIONS[name] ?? "",
      // No registry row means nothing has switched it off.
      enabled: true,
      inRegistry: false,
      connection: serverConnection(name),
      users: users(name),
      runs7d: usageBy.get(name)?.runs ?? 0,
      lastUsedAt: usageBy.get(name)?.lastUsedAt ?? null,
    });
  }
  // Servers in use first, then by name: the ones that matter sit at the top.
  entries.sort((a, b) => b.users.length - a.users.length || a.label.localeCompare(b.label));
  return { entries, roster };
}
