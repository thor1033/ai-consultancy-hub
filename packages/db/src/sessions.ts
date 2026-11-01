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
  /** Where the time went (@ai-hub/agent RunTimeline). */
  timeline?: unknown;
}

export async function recordSession(input: RecordSessionInput): Promise<string> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    insert into agent_sessions
      (prompt, system, model, effort, mcp_servers, transcript, tools_used,
       output, status, cost_usd, latency_ms, tokens, trace_id, timeline,
       agent_id, principal_id, started_at, finished_at)
    values
      (${input.prompt}, ${input.system ?? null}, ${input.model ?? null},
       ${input.effort ?? null}, ${sql.json((input.mcpServers ?? []) as never)},
       ${sql.json((input.transcript ?? []) as never)},
       ${sql.json((input.toolsUsed ?? []) as never)},
       ${input.output ?? null}, ${input.status ?? "succeeded"},
       ${input.costUsd ?? null}, ${input.latencyMs ?? null},
       ${sql.json((input.tokens ?? null) as never)}, ${input.traceId ?? null},
       ${sql.json((input.timeline ?? null) as never)},
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
  /** The run that started this one (a hand-off or an ask), and how deep the chain is. */
  parentSessionId?: string | null;
  depth?: number;
}

export async function startRun(input: StartRunInput): Promise<string> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    insert into agent_sessions
      (prompt, system, model, effort, mcp_servers, transcript,
       status, agent_id, agent_skill_id, principal_id, started_at,
       parent_session_id, depth)
    values
      (${input.prompt}, ${input.system ?? null}, ${input.model ?? null},
       ${input.effort ?? null}, ${sql.json((input.mcpServers ?? []) as never)},
       ${sql.json([] as never)},
       'running', ${input.agentId ?? null}, ${input.skillId ?? null},
       ${input.principalId ?? null}, now(),
       ${input.parentSessionId ?? null}, ${Math.max(0, Math.trunc(input.depth ?? 0))})
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
  timeline?: unknown;
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
      timeline    = ${sql.json((result.timeline ?? null) as never)},
      finished_at = now()
    where id = ${id}
  `;
}

export interface RunTiming {
  id: string;
  /** Who the run was for (the person, or a schedule's owner); null for a workbench run. */
  principalId: string | null;
  /** Their name, for "a run by …" where the prompt itself is not shown. */
  askedBy: string | null;
  agentId: string | null;
  at: string;
  status: string;
  prompt: string;
  skill: string | null;
  model: string | null;
  effort: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  tokens: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | null;
  toolsUsed: string[];
  error: string | null;
  /** Null for a run recorded before timings were kept, or one still running. */
  timeline: unknown;
  parentSessionId: string | null;
  depth: number;
}

export interface ChildRun {
  id: string;
  /** Who the run was for (the person, or a schedule's owner); null for a workbench run. */
  principalId: string | null;
  /** Their name, for "a run by …" where the prompt itself is not shown. */
  askedBy: string | null;
  agentId: string | null;
  agentSlug: string | null;
  agentName: string | null;
  status: string;
  prompt: string;
  latencyMs: number | null;
  at: string;
}

/** The runs one run started: hand-offs when it finished, asks while it ran. */
export async function listChildRuns(parentSessionId: string): Promise<ChildRun[]> {
  if (!/^[0-9a-f-]{36}$/i.test(parentSessionId)) return [];
  const sql = getSql();
  return sql<ChildRun[]>`
    select s.id, s.agent_id as "agentId", a.slug as "agentSlug", a.name as "agentName", s.status, s.prompt,
           s.latency_ms as "latencyMs", coalesce(s.started_at, s.created_at) as at, s.principal_id as "principalId", coalesce(nullif(pr.display_name, ''), pr.email, s.principal_id) as "askedBy"
      from agent_sessions s
      left join agents a on a.id = s.agent_id
      left join principals pr on pr.id = s.principal_id
     where s.parent_session_id = ${parentSessionId}
     order by coalesce(s.started_at, s.created_at)`;
}

/**
 * One run, for its page: what the agent's run list already shows, plus where
 * the time went. Deliberately not the transcript or the answer — the page is
 * as visible as the run list, and that list shows a run's prompt, not what
 * came back.
 */
export async function getRunTiming(id: string): Promise<RunTiming | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const sql = getSql();
  const [row] = await sql<RunTiming[]>`
    select s.id, s.agent_id as "agentId", coalesce(s.started_at, s.created_at) as at, s.status, s.prompt,
           k.name as skill, s.model, s.effort, s.latency_ms as "latencyMs", s.cost_usd::float8 as "costUsd",
           s.tokens, s.tools_used as "toolsUsed", s.error, s.timeline,
           s.parent_session_id as "parentSessionId", s.depth, s.principal_id as "principalId", coalesce(nullif(pr.display_name, ''), pr.email, s.principal_id) as "askedBy"
      from agent_sessions s
      left join agent_skills k on k.id = s.agent_skill_id
      left join principals pr on pr.id = s.principal_id
     where s.id = ${id}`;
  return row ?? null;
}

/**
 * Add to a finished run's answer. The hand-off to the Context Steward
 * (apps/web/src/lib/handoffs.ts) runs once the session is recorded, so
 * the steward can read it; what the hand-off says goes into the answer after.
 */
export async function appendRunOutput(id: string, line: string): Promise<void> {
  const sql = getSql();
  await sql`update agent_sessions set output = coalesce(output, '') || ${line} where id = ${id}`;
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

/** One of a person's own runs of an agent, with its answer — for "Your answers". */
export interface MyRun {
  id: string;
  status: string;
  prompt: string;
  output: string | null;
  error: string | null;
  skill: string | null;
  at: string;
}

/**
 * The runs a person started with one agent, newest first, with what came back
 * (the agent page's "Your answers"). Only their own: the answer is the
 * person's, so nobody else's appears here, whatever their role — the same
 * rule that keeps answers off the run page. Runs another agent asked for under
 * this one (asks, one level deep) are left out: the person did not ask them.
 */
export async function listMyRuns(agentId: string, principalId: string, limit = 20): Promise<MyRun[]> {
  const sql = getSql();
  return sql<MyRun[]>`
    select s.id, s.status, s.prompt, s.output, s.error, k.name as skill,
           coalesce(s.started_at, s.created_at) as at
      from agent_sessions s
      left join agent_skills k on k.id = s.agent_skill_id
     where s.agent_id = ${agentId}
       and s.principal_id = ${principalId}
       and s.parent_session_id is null
     order by coalesce(s.started_at, s.created_at) desc
     limit ${Math.max(1, Math.min(Math.trunc(limit), 100))}
  `;
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

