import { listMcpServers } from "@ai-hub/db";
import { knownServers } from "@/lib/runSession";

// What the agent builder and settings offer: the tool servers this deployment
// can actually start, with the labels and descriptions the control plane holds.

export interface ToolOption {
  name: string;
  label: string;
  description: string;
  /** Declared on this deployment. False for a server an agent still names but the hub no longer knows. */
  available: boolean;
}

const LOCAL_DESCRIPTIONS: Record<string, string> = {
  microsoft365: "Read-only Outlook mail and calendar through Microsoft Graph.",
  teams: "Read-only Teams meeting transcripts and the team's SharePoint files.",
  "teams-notes": "Saves meeting notes as new Markdown files in one Teams folder. Create-only: cannot change or delete anything.",
  knowledge: "The Context Steward's reading (recent chats, meeting notes, agents' memory, the knowledge base) and its three proposals: file, remember, retire. Every write waits for a person.",
};

export async function toolCatalog(alsoNamed: string[] = []): Promise<ToolOption[]> {
  const rows = await listMcpServers().catch(() => []);
  const byName = new Map(rows.map((r) => [r.name, r]));
  const known = knownServers().filter((n) => n !== "memory");
  const options: ToolOption[] = known.map((name) => ({
    name,
    label: byName.get(name)?.label || name,
    description: byName.get(name)?.description || LOCAL_DESCRIPTIONS[name] || "",
    available: true,
  }));
  for (const name of alsoNamed) {
    if (name === "memory" || known.includes(name)) continue;
    options.push({
      name,
      label: byName.get(name)?.label || name,
      description: "Not declared on this deployment, so runs skip it. Kept so saving does not remove it.",
      available: false,
    });
  }
  return options;
}
