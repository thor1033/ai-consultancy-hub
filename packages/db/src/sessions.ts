import { getSql } from "./client";

// The record of one agent turn: prompt, model, connected MCP servers, tools
// used, and the full transcript. Written by runSession on every /agents run, so
// a run can be read back and traced to the agent that made it.

export interface SessionSummary {
  id: string;
  prompt: string;
  model: string | null;
  mcpServers: string[];
  toolsUsed: string[];
  status: string;
  costUsd: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface SessionDetail extends SessionSummary {
  system: string | null;
  effort: string | null;
  transcript: unknown[];
  output: string | null;
  tokens: unknown;
  traceId: string | null;
}

export interface RecordSessionInput {
  prompt: string;
  system?: string;
  model?: string;
  effort?: string;
  mcpServers?: string[];
  transcript: unknown[];
  toolsUsed?: string[];
  output?: string;
  status?: string;
  costUsd?: number;
  latencyMs?: number;
  tokens?: unknown;
  traceId?: string;
}

export async function recordSession(input: RecordSessionInput): Promise<string> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    insert into agent_sessions
      (prompt, system, model, effort, mcp_servers, transcript, tools_used,
       output, status, cost_usd, latency_ms, tokens, trace_id)
    values
      (${input.prompt}, ${input.system ?? null}, ${input.model ?? null},
       ${input.effort ?? null}, ${sql.json((input.mcpServers ?? []) as never)},
       ${sql.json((input.transcript ?? []) as never)},
       ${sql.json((input.toolsUsed ?? []) as never)},
       ${input.output ?? null}, ${input.status ?? "succeeded"},
       ${input.costUsd ?? null}, ${input.latencyMs ?? null},
       ${sql.json((input.tokens ?? null) as never)}, ${input.traceId ?? null})
    returning id
  `;
  return row.id;
}

export async function listSessions(limit = 50): Promise<SessionSummary[]> {
  const sql = getSql();
  return sql<SessionSummary[]>`
    select se.id, se.prompt, se.model,
           se.mcp_servers as "mcpServers",
           se.tools_used  as "toolsUsed",
           se.status,
           se.cost_usd    as "costUsd",
           se.latency_ms  as "latencyMs",
           se.created_at  as "createdAt"
    from agent_sessions se
    order by se.created_at desc
    limit ${limit}
  `;
}

export async function getSession(id: string): Promise<SessionDetail | null> {
  const sql = getSql();
  const [row] = await sql<SessionDetail[]>`
    select se.id, se.prompt, se.system, se.model, se.effort,
           se.mcp_servers as "mcpServers",
           se.tools_used  as "toolsUsed",
           se.transcript, se.output, se.status,
           se.cost_usd    as "costUsd",
           se.latency_ms  as "latencyMs",
           se.tokens, se.trace_id as "traceId",
           se.created_at  as "createdAt"
    from agent_sessions se
    where se.id = ${id}
  `;
  return row ?? null;
}

// Links a session to the Skill it was distilled into (idempotent record-keeping,
