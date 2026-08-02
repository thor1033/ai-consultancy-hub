import { runAgent } from "@ai-hub/agent";
import type { SessionDetail } from "@ai-hub/db";

// The Skillification mechanism (docs/04, and the open question in docs/06:
// "how do we technically Skillify a context window"). Given a completed agent
// session — the practitioner's real workflow done once, end-to-end — we ask
// Claude to distill that ad-hoc transcript into a clean, reusable *system
// prompt* (the "skillified process") plus naming/ROI metadata. The MCP servers
// the session used are carried over verbatim; only the reasoning is generalized.

export interface SkillDraft {
  name: string;
  slug: string;
  description: string;
  instructions: string;
  baselineMinutes: number | null;
}

// A compact, readable rendering of the transcript for the distiller to read.
// We flatten Anthropic message blocks to text/tool-call summaries rather than
// dumping raw JSON, so the model reasons over the *workflow*, not the wire format.
function renderTranscript(transcript: unknown[]): string {
  const lines: string[] = [];
  for (const msg of transcript as Array<{ role: string; content: unknown }>) {
    const role = msg.role === "user" ? "USER" : "ASSISTANT";
    if (typeof msg.content === "string") {
      lines.push(`${role}: ${msg.content}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === "text") {
        lines.push(`${role}: ${String(block.text ?? "")}`);
      } else if (block.type === "tool_use") {
        lines.push(
          `${role} → tool ${String(block.name)}(${JSON.stringify(block.input)})`,
        );
      } else if (block.type === "tool_result") {
        const c = block.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c
                  .map((x) =>
                    typeof x === "object" && x && "text" in x
                      ? String((x as { text: unknown }).text)
                      : "",
                  )
                  .join("")
              : JSON.stringify(c);
        lines.push(`TOOL RESULT: ${text.slice(0, 800)}`);
      }
    }
  }
  return lines.join("\n");
}

const DISTILL_SYSTEM = `You are a Skill author for an AI hub. You are given a transcript of ONE expert working through a real task end-to-end, using tools (MCP servers). Your job is to distill that specific run into a REUSABLE Skill that any colleague can run on new but similar inputs.

Produce a JSON object with exactly these fields:
- "name": a short human title for the Skill (Title Case, no quotes).
- "slug": a url-safe kebab-case id derived from the name.
- "description": one sentence on what the Skill does and when to use it.
- "instructions": the reusable SYSTEM PROMPT for the Skill. Write it as a numbered, tool-aware procedure that generalizes the transcript: keep the sequence of tool calls and the domain reasoning, but replace this run's specific inputs (names, numbers, dates) with instructions to gather them from the user's input or the tools. Name the tools/servers to use at each step. Do NOT hardcode this run's answer.
- "baselineMinutes": your best integer estimate of how long this task takes a skilled human to do manually, or null if unknown.

Respond with ONLY the JSON object, no prose, no code fences.`;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Runs the distiller over a session and returns a draft Skill for review.
export async function distillSkill(session: SessionDetail): Promise<SkillDraft> {
  const prompt = `TASK THE EXPERT WAS GIVEN:\n${session.prompt}\n\nMCP SERVERS AVAILABLE THIS SESSION: ${
    session.mcpServers.length ? session.mcpServers.join(", ") : "none"
  }\nTOOLS ACTUALLY USED: ${
    session.toolsUsed.length ? session.toolsUsed.join(", ") : "none"
  }\n\nTRANSCRIPT:\n${renderTranscript(session.transcript)}`;

  const result = await runAgent({
    prompt,
    system: DISTILL_SYSTEM,
    // Distillation is judgment work; give it real thinking budget.
    effort: "high",
    metadata: { source: "skillify.distill", sessionId: session.id },
  });

  const draft = parseDraft(result.text);
  // Never trust the model for the slug shape.
  const name = draft.name?.trim() || "Untitled Skill";
  return {
    name,
    slug: draft.slug ? slugify(draft.slug) : slugify(name),
    description: draft.description?.trim() || "",
    instructions: draft.instructions?.trim() || "",
    baselineMinutes:
      typeof draft.baselineMinutes === "number" && draft.baselineMinutes > 0
        ? Math.round(draft.baselineMinutes)
        : null,
  };
}

interface RawDraft {
  name?: string;
  slug?: string;
  description?: string;
  instructions?: string;
  baselineMinutes?: number;
}

// The distiller is told to return bare JSON, but be forgiving: strip code fences
// and extract the first {...} block if it wrapped the object in prose.
function parseDraft(text: string): RawDraft {
  const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
  try {
    return JSON.parse(cleaned) as RawDraft;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as RawDraft;
      } catch {
        /* fall through */
      }
    }
    throw new Error("Could not parse a Skill draft from the distiller output.");
  }
}

// Maps the session's connected server names to the {name} marker form that
// skill_versions.mcp_servers stores and runSkill resolves.
export function serverMarkers(names: string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}
