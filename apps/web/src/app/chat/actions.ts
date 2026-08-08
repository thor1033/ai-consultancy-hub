"use server";

import { getRunnableSkill } from "@ai-hub/db";
import { retrieveChunks, chunksToContext } from "@ai-hub/rag";
import { runSession, isKnownServer } from "@/lib/runSession";
import type { ModelId } from "@ai-hub/agent";

// One chat turn, powered by the hub: an optional Skill preset (system prompt +
// MCP servers + knowledge scope), the selected MCP servers, and RAG context
// retrieved for this message. Turn-based (no streaming yet) and stateless — the
// client sends the running transcript each turn; persistence lands in Slice 2.
// Runs server-trusted like the other dashboard actions (auth is a separate gap).

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
export interface ChatConfig {
  servers: string[];
  skillSlug?: string | null;
  useRag?: boolean;
}
export interface ChatMeta {
  model: string;
  costUsd: number;
  latencyMs: number;
  toolsUsed: string[];
  servers: string[];
  sources: number;
  skill?: string;
}

const MAX_TURNS = 40;      // history turns kept
const MAX_MESSAGE = 8_000; // chars per user message

const effortOf = (v: string | null | undefined) =>
  v === "low" || v === "medium" || v === "high" || v === "max" ? v : undefined;

// Skill MCP entries are stored as opaque markers; pull a usable server name out.
function serverName(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
    return (entry as { name: string }).name;
  }
  return null;
}

export async function sendChatAction(messages: ChatMessage[], config: ChatConfig) {
  const clean = (messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim(),
  );
  if (!clean.length) return { error: "Say something first." };
  const last = clean[clean.length - 1];
  if (last.role !== "user") return { error: "The last message must be from you." };
  if (last.content.length > MAX_MESSAGE) return { error: "That message is too long." };

  const history = clean.slice(0, -1).slice(-MAX_TURNS).map((m) => ({ role: m.role, content: m.content }));
  const prompt = last.content;

  // Skill preset.
  let system: string | undefined;
  let model: ModelId | undefined;
  let effort: "low" | "medium" | "high" | "max" | undefined;
  let collection: string | null = null;
  let skillName: string | undefined;
  const servers = new Set<string>((config.servers ?? []).filter(isKnownServer));
  if (config.skillSlug) {
    const skill = await getRunnableSkill(config.skillSlug);
    if (!skill) return { error: `Unknown skill: ${config.skillSlug}` };
    system = skill.instructions;
    model = (skill.model as ModelId) ?? undefined;
    effort = effortOf(skill.effort);
    collection = skill.knowledgeCollection;
    skillName = skill.slug;
    for (const e of skill.mcpServers ?? []) {
      const n = serverName(e);
      if (n && isKnownServer(n)) servers.add(n);
    }
  }

  // RAG: retrieve context for this turn when asked, or when the skill is scoped
  // to a knowledge collection. Best-effort — a retrieval failure never blocks chat.
  let context: string | undefined;
  let sources = 0;
  if (config.useRag || collection) {
    try {
      const chunks = await retrieveChunks(prompt, 5, collection ? { collection } : {});
      if (chunks.length) {
        context = chunksToContext(chunks);
        sources = chunks.length;
      }
    } catch {
      /* retrieval unavailable (no embedder / empty index) — answer without it */
    }
  }

  try {
    const { result, servers: used } = await runSession({
      prompt, history, system, context, model, effort, servers: [...servers],
    });
    const meta: ChatMeta = {
      model: result.model,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      toolsUsed: result.toolsUsed,
      servers: used,
      sources,
      skill: skillName,
    };
    return { role: "assistant" as const, content: result.text, meta };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "The chat turn failed." };
  }
}
