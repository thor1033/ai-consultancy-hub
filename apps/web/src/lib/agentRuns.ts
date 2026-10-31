import { getAgent, getSkill, startRun, failRun, runsOnHub, askedAgents, type Agent, type SkillWithAgent, knowledgeScope, retrievalScope } from "@ai-hub/db";
import { runHandoffs } from "@/lib/handoffs";
import { ASK_MAX_DEPTH, ASK_TIMEOUT_MS, type Asks } from "@/lib/askAgents";
import { retrieveChunks, chunksToContext } from "@ai-hub/rag";
import { authorize, knowledgeAccessFor, type Principal } from "@ai-hub/authz";
import { runSession, isKnownServer } from "@/lib/runSession";
import { type ModelId } from "@ai-hub/agent";
import { fillTemplate } from "@/lib/skillPrompt";

/*
 * Running a standing agent on behalf of an outside caller.
 *
 * This is what makes an agent built in the hub usable from Claude Code, VS
 * Code, Cursor or ChatGPT: the same agent, with its own instructions, memory
 * and curated knowledge, reachable wherever the person already works instead of
 * only inside /agents.
 *
 * Two problems have to be solved here rather than at the call site, because
 * every surface hits both.
 *
 * 1. TIME. An agent doing real multi-turn tool use takes minutes; every MCP
 *    client's tool-call timeout is far shorter (Claude Code defaults to 60s).
 *    A synchronous-only design would fail the exact runs worth having, while
 *    still burning the tokens. So a run races a deadline: if it finishes in
 *    time the caller gets the answer directly, and if it does not they get a
 *    run id to poll. Short runs feel instant; long ones degrade instead of
 *    failing. The work continues either way — the hub is a long-running
 *    container, not a serverless function, so nothing is torn down when the
 *    HTTP response goes out.
 *
 * 2. WHOSE ACCESS. The agent retrieves as the CALLER, never with a reach of its
 *    own, for the same reason the browser chat does (see agents/actions.ts): an
 *    agent scoped to a restricted collection must not become the way anyone
 *    reads that collection. Its knowledge scope is curation; the caller's
 *    grants are permission, and the two are ANDed in retrieveChunks.
 */

/**
 * How long to hold the caller's request before handing back a run id.
 *
 * Under Claude Code's 60s default this leaves room for the response itself. It
 * is not a limit on the run — the run keeps going — only on how long we make
 * the client wait before switching to polling.
 */
export const DEFAULT_DEADLINE_MS = 45_000;

export type AgentRunOutcome =
  | { kind: "done"; runId: string; output: string; toolsUsed: string[]; sources: number }
  | { kind: "running"; runId: string; agentName: string }
  | { kind: "error"; message: string };

export interface AgentRunInput {
  /** Agent id or slug — getAgent resolves either, and a slug is what config holds. */
  agentRef: string;
  prompt: string;
  principal: Principal;
  deadlineMs?: number;
  /** The skill this run came from, when it came from one. */
  skillId?: string | null;
  /** The skill by slug and name, for the hand-offs keyed to it. */
  skill?: { slug: string; name: string } | null;
  /** Prior chat turns, for the conversation on the agent's page. */
  history?: { role: "user" | "assistant"; content: string }[];
  /**
   * The run this one is started by — a hand-off when it finished, or an ask
   * while it ran — and how deep the chain is. Absent for a person's or the
   * clock's run (depth 0).
   */
  parent?: { sessionId: string; depth: number } | null;
}

/**
 * How this agent works with others on this run (docs/agent-patterns.md):
 * whether it keeps memory, whom it may ask, and the hand-offs that fire when
 * it finishes. One place, so the chat on the agent's page, a client's tool
 * call, a schedule and a hand-off all cooperate the same way.
 */
export async function cooperation(agent: Agent, principal: Principal, runId: string, depth: number) {
  const askable = askedAgents(agent.mcpServers).filter((slug) => slug !== agent.slug);
  let asks: Asks | undefined;
  if (askable.length && depth < ASK_MAX_DEPTH) {
    // Only agents that exist, are on, and run on the hub are offered: the
    // tool's description lists them, so a slug that would only refuse is
    // left out rather than shown.
    const allowed = (await Promise.all(askable.map((slug) => getAgent(slug))))
      .filter((a): a is Agent => Boolean(a && a.enabled && runsOnHub(a.placement)))
      .map((a) => ({ slug: a.slug, name: a.name, description: a.description }));
    if (allowed.length) {
      asks = {
        allowed,
        start: async (slug, task) => {
          const out = await runAgentForPrincipal({ agentRef: slug, prompt: task, principal, deadlineMs: ASK_TIMEOUT_MS, parent: { sessionId: runId, depth: depth + 1 } });
          return out.kind === "done" ? { kind: "done", runId: out.runId, output: out.output } : out.kind === "running" ? { kind: "running", runId: out.runId } : out;
        },
      };
    }
  }
  return { keepsMemory: agent.keepsMemory, asks };
}

/** The hand-offs of a finished run, as the run's afterRun (lib/handoffs.ts). */
export function handoffsAfter(run: Omit<Parameters<typeof runHandoffs>[0], "output">): (result: { text: string }) => Promise<string> {
  // The next agent is started the way any agent is, so every check on the way
  // (may this person run agents, is the agent on) holds; its run is not
  // waited for, and the person reads in this answer that it was started.
  return (result) =>
    runHandoffs({ ...run, output: result.text }, (agentRef, p, who, parent) => runAgentForPrincipal({ agentRef, prompt: p, principal: who, deadlineMs: 1, parent }));
}

/** The agents this principal may run, for tool generation and for listing. */
export async function runnableAgent(
  agentRef: string,
  principal: Principal,
): Promise<Agent | { error: string }> {
  if (!(await authorize(principal, "agent:run"))) {
    return { error: "You are not permitted to run agents." };
  }
  const agent = await getAgent(agentRef);
  if (!agent) return { error: `No agent named "${agentRef}".` };
  if (!agent.enabled) return { error: `"${agent.name}" is disabled.` };
  // Every hub-side path (MCP tools, skills, schedules) comes through here, so
  // this one check is what makes "local" mean the hub never runs it.
  if (!runsOnHub(agent.placement)) {
    return {
      error: `"${agent.name}" runs locally, in Claude Code, not on the hub. Use its synced sub-agent, or set it to run on the hub or both.`,
    };
  }
  return agent;
}

export async function runAgentForPrincipal(input: AgentRunInput): Promise<AgentRunOutcome> {
  const found = await runnableAgent(input.agentRef, input.principal);
  if ("error" in found) return { kind: "error", message: found.error };
  const agent = found;

  const prompt = input.prompt.trim();
  if (!prompt) return { kind: "error", message: "Say what you want the agent to do." };

  // Retrieved as the caller. A collection they may not read yields nothing,
  // rather than an agent that quietly answers from material its operator cannot
  // open. Best-effort: a missing embedder must not take the run down.
  let context: string | undefined;
  let sources = 0;
  const scope = retrievalScope(knowledgeScope(agent));
  if (scope) {
    try {
      const chunks = await retrieveChunks(prompt, await knowledgeAccessFor(input.principal), 5, scope);
      if (chunks.length) {
        context = chunksToContext(chunks);
        sources = chunks.length;
      }
    } catch {
      /* retrieval unavailable — answer without it */
    }
  }

  const servers = (agent.mcpServers ?? [])
    .map((e) => (typeof e === "string" ? e : String((e as { name?: unknown }).name ?? "")))
    .filter((n) => n && isKnownServer(n));

  const depth = input.parent?.depth ?? 0;
  const runId = await startRun({
    prompt,
    agentId: agent.id,
    skillId: input.skillId ?? null,
    principalId: input.principal.id,
    system: agent.instructions || undefined,
    model: agent.model ?? undefined,
    effort: agent.effort ?? undefined,
    mcpServers: servers,
    parentSessionId: input.parent?.sessionId ?? null,
    depth,
  });
  const together = await cooperation(agent, input.principal, runId, depth);

  // Started before the race so it is never abandoned: whichever way the race
  // goes, this promise owns finishing or failing the row.
  const work = runSession({
    prompt,
    history: input.history,
    context,
    system: agent.instructions || undefined,
    model: (agent.model as ModelId) ?? undefined,
    effort: effortOf(agent.effort),
    maxIterations: agent.maxIterations ?? undefined,
    servers,
    agentId: agent.id,
    principalId: input.principal.id,
    remoteBearer: input.principal.accessToken,
    serverEntries: agent.mcpServers,
    runId,
    keepsMemory: together.keepsMemory,
    asks: together.asks,
    afterRun: handoffsAfter({
      sessionId: runId,
      agentId: agent.id,
      agentName: agent.name,
      skillId: input.skillId ?? null,
      skillName: input.skill?.name ?? null,
      prompt,
      principal: input.principal,
      depth,
    }),
  })
    .then((out) => ({ ok: true as const, out }))
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : "The run failed.";
      await failRun(runId, message).catch(() => {});
      return { ok: false as const, message };
    });

  // An unhandled rejection here would take the whole container down with it,
  // and the catch above only covers runSession — failRun can throw too.
  work.catch(() => {});

  const deadline = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), input.deadlineMs ?? DEFAULT_DEADLINE_MS).unref?.(),
  );

  const raced = await Promise.race([work, deadline]);

  if (raced === "timeout") {
    return { kind: "running", runId, agentName: agent.name };
  }
  if (!raced.ok) return { kind: "error", message: raced.message };

  return {
    kind: "done",
    runId,
    output: raced.out.result.text ?? "",
    toolsUsed: raced.out.result.toolsUsed ?? [],
    sources,
  };
}

function effortOf(value: string | null): "low" | "medium" | "high" | "max" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "max"
    ? value
    : undefined;
}


/**
 * Run a skill: fill its template from the caller's arguments, then run its agent.
 *
 * The agent is resolved through runnableAgent, so a skill cannot be a way round
 * an agent someone disabled or a role that may not run agents. Validation
 * happens before the run row is created — a rejected argument should cost
 * nothing and leave nothing behind.
 */
export async function runSkillForPrincipal(input: {
  skillRef: string;
  args: Record<string, unknown>;
  principal: Principal;
  deadlineMs?: number;
}): Promise<AgentRunOutcome> {
  const skill = await getSkill(input.skillRef);
  if (!skill) return { kind: "error", message: `No skill named "${input.skillRef}".` };
  if (!skill.enabled) return { kind: "error", message: `"${skill.name}" is disabled.` };
  if (!skill.agentEnabled) {
    return { kind: "error", message: `"${skill.agentName}" is disabled, so its skills cannot run.` };
  }

  const filled = fillTemplate(skill.promptTemplate, skill.parameters ?? [], input.args ?? {});
  if ("error" in filled) return { kind: "error", message: filled.error };

  return runAgentForPrincipal({
    agentRef: skill.agentId,
    prompt: filled.prompt,
    principal: input.principal,
    deadlineMs: input.deadlineMs,
    skillId: skill.id,
    skill: { slug: skill.slug, name: skill.name },
  });
}

export type { SkillWithAgent };
