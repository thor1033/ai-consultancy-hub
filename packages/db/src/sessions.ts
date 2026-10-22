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
  agentId?: string | null;
  principalId?: string | null;
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
       output, status, cost_usd, latency_ms, tokens, trace_id,
       agent_id, principal_id, started_at, finished_at)
    values
      (${input.prompt}, ${input.system ?? null}, ${input.model ?? null},
       ${input.effort ?? null}, ${sql.json((input.mcpServers ?? []) as never)},
       ${sql.json((input.transcript ?? []) as never)},
       ${sql.json((input.toolsUsed ?? []) as never)},
       ${input.output ?? null}, ${input.status ?? "succeeded"},
       ${input.costUsd ?? null}, ${input.latencyMs ?? null},
       ${sql.json((input.tokens ?? null) as never)}, ${input.traceId ?? null},
       ${input.agentId ?? null}, ${input.principalId ?? null}, now(), now())
    returning id
  `;
  return row.id;
}

// --- the run lifecycle ------------------------------------------------------
//
// recordSession above writes a finished run in one statement — the synchronous
// path, unchanged. These three are for a run that outlives the request that
// started it: a client whose tool call would time out is handed the id instead,
// and polls. The row is the handoff.

export interface StartRunInput {
  prompt: string;
  agentId?: string | null;
  skillId?: string | null;
  principalId?: string | null;
  system?: string;
  model?: string;
  effort?: string;
  mcpServers?: string[];
}

export async function startRun(input: StartRunInput): Promise<string> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    insert into agent_sessions
      (prompt, system, model, effort, mcp_servers, transcript,
       status, agent_id, agent_skill_id, principal_id, started_at)
    values
      (${input.prompt}, ${input.system ?? null}, ${input.model ?? null},
       ${input.effort ?? null}, ${sql.json((input.mcpServers ?? []) as never)},
       ${sql.json([] as never)},
       'running', ${input.agentId ?? null}, ${input.skillId ?? null},
       ${input.principalId ?? null}, now())
    returning id
  `;
  return row.id;
}

export interface FinishRunInput {
  transcript?: unknown[];
  toolsUsed?: string[];
  output?: string;
  model?: string;
  costUsd?: number;
  latencyMs?: number;
  tokens?: unknown;
  traceId?: string;
}

export async function finishRun(id: string, result: FinishRunInput): Promise<void> {
  const sql = getSql();
  await sql`
    update agent_sessions set
      status      = 'succeeded',
      transcript  = ${sql.json((result.transcript ?? []) as never)},
      tools_used  = ${sql.json((result.toolsUsed ?? []) as never)},
      output      = ${result.output ?? null},
      model       = coalesce(${result.model ?? null}, model),
      cost_usd    = ${result.costUsd ?? null},
      latency_ms  = ${result.latencyMs ?? null},
      tokens      = ${sql.json((result.tokens ?? null) as never)},
      trace_id    = ${result.traceId ?? null},
      finished_at = now()
    where id = ${id}
  `;
}

/**
 * Mark a run failed.
 *
 * The message is stored rather than only logged: whoever asked for this run is
 * holding a run id and polling, and "failed" with no reason sends them to a
 * container log they cannot read from their editor.
 */
export async function failRun(id: string, error: string): Promise<void> {
  const sql = getSql();
  await sql`
    update agent_sessions
       set status = 'failed', error = ${error.slice(0, 2000)}, finished_at = now()
     where id = ${id}
  `;
}

export interface RunStatus {
  id: string;
  status: string;
  agentId: string | null;
  principalId: string | null;
  prompt: string;
  output: string | null;
  error: string | null;
  toolsUsed: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Read a run back, for polling.
 *
 * Scoped to the principal that started it. A run id is a bearer of its own
 * output — the whole transcript of an agent working over the company's
 * knowledge — so handing one to whoever guesses a uuid would undo increment 02
 * one run at a time.
 */
export async function getRunStatus(
  id: string,
  principalId: string,
): Promise<RunStatus | null> {
  const sql = getSql();
  const [row] = await sql<RunStatus[]>`
    select id, status,
           agent_id     as "agentId",
           principal_id as "principalId",
           prompt, output, error,
           tools_used   as "toolsUsed",
           started_at   as "startedAt",
           finished_at  as "finishedAt"
      from agent_sessions
     where id = ${id} and principal_id = ${principalId}
  `;
  return row ?? null;
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

/** One run of a brief skill, as the Briefs page shows it. */
export interface Brief {
  id: string;
  status: string;
  output: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  costUsd: number | null;
  agentSlug: string;
  agentName: string;
  skillId: string;
  skillSlug: string;
  skillName: string;
  /** Who the run executed as: the schedule's owner, or whoever pressed Run now. */
  principalId: string | null;
  principalName: string | null;
}

/**
 * Runs of skills whose kind is `brief`, newest first — the morning meeting
 * prep and whatever else is set up to publish rather than answer. Not scoped
 * to a principal on purpose: a brief is about the shared record (the
 * Secretary's own calendar and mailbox), and the page that shows it already
 * requires agent:run. A brief that read someone's private material would be
 * a different feature with a different query.
 */
export async function listBriefs(limit = 30): Promise<Brief[]> {
  const sql = getSql();
  return sql<Brief[]>`
    select se.id, se.status, se.output, se.error,
           se.started_at  as "startedAt",
           se.finished_at as "finishedAt",
           se.cost_usd::float8 as "costUsd",
           a.slug  as "agentSlug",
           a.name  as "agentName",
           k.id    as "skillId",
           k.slug  as "skillSlug",
           k.name  as "skillName",
           se.principal_id as "principalId",
           p.display_name  as "principalName"
      from agent_sessions se
      join agent_skills k on k.id = se.agent_skill_id and k.kind = 'brief'
      join agents a on a.id = se.agent_id
      left join principals p on p.id = se.principal_id
     order by coalesce(se.started_at, se.created_at) desc
     limit ${limit}
  `;
}
