import { getSql } from "./client";
import { MEMORY_REGIONS, memoryReachPredicate, type MemoryRegion, type MemoryReach, type MemoryScope } from "./agents";

// Everything the Context page draws, read in one round of queries: what each
// agent remembers, what it can do, what it is connected to, who it knows about,
// and what it has been doing. Read-only; the page is a live view, not an editor.

export interface ContextAgent {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  brief: string;
  servers: string[];
  knowledgeCollections: string[];
  knowledgeAll: boolean;
  lastRunAt: string | null;
}

export interface ContextMemory {
  id: string;
  agentId: string;
  /** Who may have it loaded (docs/memory-scopes.md). */
  scope: MemoryScope;
  scopeRef: string;
  key: string;
  content: string;
  active: boolean;
  region: MemoryRegion | null;
  updatedAt: string;
}

export interface ContextSkill {
  id: string;
  agentId: string;
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ContextServer {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  usedBy: string[];
}

export interface ContextPerson {
  id: string;
  name: string;
  email: string;
  roles: string[];
  enabled: boolean;
}

export interface ContextSchedule {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface ContextActivity {
  at: string;
  kind: "run" | "memory";
  agentId: string;
  title: string;
  status: string | null;
}

export interface ContextSnapshot {
  takenAt: string;
  agents: ContextAgent[];
  memories: ContextMemory[];
  skills: ContextSkill[];
  servers: ContextServer[];
  people: ContextPerson[];
  schedules: ContextSchedule[];
  knowledge: { documents: number; collections: number };
  activity: ContextActivity[];
}

const asRegion = (v: unknown): MemoryRegion | null =>
  typeof v === "string" && (MEMORY_REGIONS as readonly string[]).includes(v) ? (v as MemoryRegion) : null;

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const serverNames = (entries: unknown): string[] =>
  Array.isArray(entries)
    ? entries
        .map((e) => (typeof e === "string" ? e : String((e as { name?: unknown })?.name ?? "")))
        .filter(Boolean)
    : [];

/** `reach` narrows memories to what the viewer may see; omitted, every memory (admins). */
export async function contextSnapshot(reach?: MemoryReach): Promise<ContextSnapshot> {
  const sql = getSql();
  const [agentRows, memoryRows, skillRows, serverRows, peopleRows, scheduleRows, knowledgeRows, runRows] =
    await Promise.all([
      sql<
        {
          id: string;
          slug: string;
          name: string;
          enabled: boolean;
          instructions: string;
          mcpServers: unknown;
          knowledgeCollections: string[];
          knowledgeAll: boolean;
          lastRunAt: Date | null;
        }[]
      >`
        select a.id, a.slug, a.name, a.enabled, a.instructions,
               a.mcp_servers as "mcpServers", a.knowledge_collections as "knowledgeCollections",
               a.knowledge_all as "knowledgeAll",
               (select max(coalesce(s.started_at, s.created_at)) from agent_sessions s
                 where s.agent_id = a.id) as "lastRunAt"
          from agents a
         order by a.name
      `,
      sql<{ id: string; agentId: string; scope: MemoryScope; scopeRef: string; key: string; content: string; active: boolean; region: string | null; updatedAt: Date }[]>`
        select id, agent_id as "agentId", scope, scope_ref as "scopeRef", key, content, active, region, updated_at as "updatedAt"
          from agent_memories
         where ${memoryReachPredicate(reach)}
         order by updated_at desc
      `,
      sql<ContextSkill[]>`
        select id, agent_id as "agentId", slug, name, description, enabled
          from agent_skills
         order by name
      `,
      sql<{ name: string; label: string; description: string; enabled: boolean }[]>`
        select name, label, description, enabled from mcp_servers
      `,
      sql<{ id: string; displayName: string; email: string | null; roles: unknown; enabled: boolean }[]>`
        select id, display_name as "displayName", email, roles, enabled
          from principals
         where email is not null
         order by display_name, email
      `,
      sql<{ id: string; agentId: string; name: string; enabled: boolean; lastRunAt: Date | null; lastError: string | null }[]>`
        select id, agent_id as "agentId", name, enabled, last_run_at as "lastRunAt", last_error as "lastError"
          from agent_schedules
         order by name
      `,
      sql<{ documents: number; collections: number }[]>`
        select (select count(*)::int from documents) as documents,
               (select count(*)::int from collections) as collections
      `,
      sql<{ at: Date; agentId: string; prompt: string; status: string; skill: string | null }[]>`
        select coalesce(s.started_at, s.created_at) as at, s.agent_id as "agentId",
               s.prompt, s.status, k.name as skill
          from agent_sessions s
          left join agent_skills k on k.id = s.agent_skill_id
         where s.agent_id is not null
         order by coalesce(s.started_at, s.created_at) desc
         limit 12
      `,
    ]);

  const agents: ContextAgent[] = agentRows.map((a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    enabled: a.enabled,
    brief: a.instructions,
    servers: serverNames(a.mcpServers),
    knowledgeCollections: a.knowledgeCollections ?? [],
    knowledgeAll: a.knowledgeAll,
    lastRunAt: a.lastRunAt ? iso(a.lastRunAt) : null,
  }));

  // A server an agent names but the control plane has never listed is still a
  // live connection on the map, so the registry is the overlay, not the source.
  const byName = new Map<string, ContextServer>();
  for (const r of serverRows) byName.set(r.name, { ...r, usedBy: [] });
  for (const a of agents) {
    for (const name of a.servers) {
      if (name === "memory") continue;
      const s = byName.get(name) ?? { name, label: "", description: "", enabled: true, usedBy: [] };
      s.usedBy.push(a.id);
      byName.set(name, s);
    }
  }

  const memories: ContextMemory[] = memoryRows.map((m) => ({
    id: m.id,
    agentId: m.agentId,
    scope: m.scope,
    scopeRef: m.scopeRef,
    key: m.key,
    content: m.content,
    active: m.active,
    region: asRegion(m.region),
    updatedAt: iso(m.updatedAt),
  }));

  const runActivity: ContextActivity[] = runRows.map((r) => ({
    at: iso(r.at),
    kind: "run",
    agentId: r.agentId,
    title: r.skill ?? (r.prompt.length > 70 ? r.prompt.slice(0, 70).trimEnd() + "…" : r.prompt),
    status: r.status,
  }));
  const memoryActivity: ContextActivity[] = memories.slice(0, 12).map((m) => ({
    at: m.updatedAt,
    kind: "memory",
    agentId: m.agentId,
    title: m.key,
    status: m.active ? null : "set aside",
  }));

  return {
    takenAt: new Date().toISOString(),
    agents,
    memories,
    skills: skillRows,
    servers: [...byName.values()].filter((s) => s.usedBy.length > 0),
    people: peopleRows.map((p) => ({
      id: p.id,
      name: p.displayName || (p.email ?? p.id),
      email: p.email ?? "",
      roles: Array.isArray(p.roles) ? (p.roles as string[]) : [],
      enabled: p.enabled,
    })),
    schedules: scheduleRows.map((s) => ({
      ...s,
      lastRunAt: s.lastRunAt ? iso(s.lastRunAt) : null,
    })),
    knowledge: knowledgeRows[0] ?? { documents: 0, collections: 0 },
    activity: [...runActivity, ...memoryActivity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
  };
}
