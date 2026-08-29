import { listSkills } from "@ai-hub/db";
import { knownServers } from "@/lib/runSession";
import { Chat } from "./Chat";

export const dynamic = "force-dynamic";

// A normal chat, powered by the hub: Skills as presets, MCP servers as tools,
// and RAG as retrieved context. Turn-based for now (streaming + persistence next).
export default async function ChatPage() {
  let skills: { slug: string; name: string }[] = [];
  try {
    skills = (await listSkills()).map((s) => ({ slug: s.slug, name: s.name }));
  } catch {
    /* DB down — chat still works without the Skill presets. */
  }
  return <Chat skills={skills} servers={knownServers()} />;
}
