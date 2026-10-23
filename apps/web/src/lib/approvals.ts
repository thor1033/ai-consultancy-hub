import type { Principal } from "@ai-hub/authz";
import { authorize } from "@ai-hub/authz";
import {
  claimProposal,
  createProposal,
  finishProposal,
  getAgent,
  getProposal,
  rejectProposal,
  type McpEntry,
  type Proposal,
} from "@ai-hub/db";
import { connectMcpServers, type ConnectedMcp, type McpToolInfo } from "@ai-hub/mcp";
import { isReadOnlyTool } from "@/lib/mcp/proxyTools";
import { entryName, resolveServer } from "@/lib/runSession";

/*
 * The approval gate.
 *
 * No agent writes unattended until a person has said yes. A tool call that
 * would write is HELD: recorded as a proposal, and the model is told so. A
 * person approves it, and the hub executes the very call that was held — the
 * same tool, the same arguments, shown to the approver byte for byte. Nothing
 * is re-derived at approval time, because an approver approves what they saw.
 *
 * What counts as a write is the server's word, read conservatively: a tool is
 * a write unless it carries readOnlyHint: true. "Not proven read-only" is the
 * safe reading, the same one proxyTools.ts uses to drop writes. A server that
 * annotates nothing therefore has every tool held until it annotates — or
 * until an admin marks the agent's entry `"writes": "allow"`, which is the one
 * switch, and it is per agent, per server, so it can be audited in /agents.
 *
 * Two things are never held: the agent's own memory (it never leaves the
 * hub), and the hub's own hub_* tools (each decides for itself).
 */

export type WritesPolicy = "ask" | "allow";

/** The entry's policy for tools that write. Anything but an explicit "allow" asks. */
export function writesPolicy(entry: McpEntry | undefined): WritesPolicy {
  return (entry as { writes?: unknown } | undefined)?.writes === "allow" ? "allow" : "ask";
}

export const NEVER_HELD_SERVERS: ReadonlySet<string> = new Set(["memory"]);

/** Whether a call to this tool must be approved before it runs. */
export function needsApproval(tool: Pick<McpToolInfo, "name" | "server" | "annotations">, entry: McpEntry | undefined): boolean {
  if (NEVER_HELD_SERVERS.has(tool.server)) return false;
  if (tool.name.startsWith("hub_")) return false;
  if (isReadOnlyTool(tool as McpToolInfo)) return false;
  return writesPolicy(entry) === "ask";
}

/** What the model is told instead of a result. Explicit, so it does not retry or pretend. */
export function heldText(proposal: Pick<Proposal, "id" | "tool" | "server">): string {
  return (
    `HELD FOR APPROVAL. \`${proposal.tool}\` (${proposal.server}) was NOT executed. ` +
    `It is recorded as proposal ${proposal.id} and a person must approve it on the hub's Approvals page ` +
    `before it happens. Carry on as if it has not happened: do not retry it, do not assume its effect, ` +
    `and tell the reader exactly what you proposed and that it awaits approval.`
  );
}

export interface GateContext {
  agentId?: string | null;
  runId?: string | null;
  principalId?: string | null;
  /** The agent's server entries, for the per-entry policy. */
  entries?: McpEntry[];
  /**
   * Filled in as calls are held: the names of tools whose calls did not
   * happen. A caller that does something after a tool "was used" (filing
   * saved notes, say) checks this first, because the model's call is in
   * toolsUsed whether or not the hub let it through.
   */
  held?: Set<string>;
}

/**
 * A tool executor that holds writes.
 *
 * Wraps a connected set of servers: read tools pass straight through, writes
 * become proposals. The tool list the model sees is unchanged — it may still
 * ask for the write, and learns from the result that it was held.
 */
export function gatedExecutor(mcp: ConnectedMcp, ctx: GateContext): ConnectedMcp["execute"] {
  const byName = new Map(mcp.details.map((t) => [t.name, t]));
  const entryFor = (server: string) => ctx.entries?.find((e) => entryName(e) === server);
  return async (name, input) => {
    const tool = byName.get(name);
    if (tool && needsApproval(tool, entryFor(tool.server))) {
      const proposal = await hold(tool, input, ctx);
      ctx.held?.add(tool.name);
      return heldText(proposal);
    }
    return mcp.execute(name, input);
  };
}

/** Record a held call. Exported for the per-agent endpoint, which wraps calls itself. */
export async function hold(tool: McpToolInfo, input: unknown, ctx: GateContext): Promise<Proposal> {
  return createProposal({
    agentId: ctx.agentId ?? null,
    runId: ctx.runId ?? null,
    principalId: ctx.principalId ?? null,
    server: tool.server,
    tool: tool.name,
    args: (input && typeof input === "object" ? input : {}) as Record<string, unknown>,
    description: tool.description,
  });
}

/**
 * Who may decide a proposal: an admin, or the person whose reach the run had —
 * and never an agent. A credential bound to an agent is the agent's own key,
 * and an agent approving its own writes is no gate at all.
 */
export async function mayDecide(principal: Principal, proposal: Proposal): Promise<boolean> {
  if (principal.agentId) return false;
  if (!(await authorize(principal, "agent:run"))) return false;
  if (await authorize(principal, "admin:manage")) return true;
  return Boolean(proposal.principalId) && proposal.principalId === principal.id;
}

export type Decision =
  | { ok: true; proposal: Proposal }
  | { error: string };

/** Say no. */
export async function reject(id: string, principal: Principal, note?: string): Promise<Decision> {
  const proposal = await getProposal(id);
  if (!proposal) return { error: "No such proposal." };
  if (!(await mayDecide(principal, proposal))) return { error: "You may not decide this proposal." };
  if (!(await rejectProposal(id, principal.id, note))) return { error: `This proposal is already ${proposal.status}.` };
  return { ok: true, proposal: (await getProposal(id))! };
}

/**
 * Say yes: execute the held call.
 *
 * Dialled the way the run would have dialled it, from the agent's entry and
 * the hub's own credential for that server. A person's forwarded token is
 * never stored with a proposal (it expires in minutes and must not sit in a
 * table), so an entry that only ever wrote as a person fails here with the
 * upstream's refusal, recorded on the proposal. The fix is the right one: give
 * the agent the entry whose credential may write, and let this gate hold it.
 */
export async function approve(id: string, principal: Principal): Promise<Decision> {
  const proposal = await getProposal(id);
  if (!proposal) return { error: "No such proposal." };
  if (!(await mayDecide(principal, proposal))) return { error: "You may not decide this proposal." };
  if (!(await claimProposal(id, principal.id))) return { error: `This proposal is already ${proposal.status}.` };

  const fail = async (error: string): Promise<Decision> => {
    await finishProposal(id, { error });
    return { ok: true, proposal: (await getProposal(id))! };
  };

  const agent = proposal.agentId ? await getAgent(proposal.agentId) : null;
  if (proposal.agentId && !agent) return fail("The agent this proposal belongs to no longer exists.");
  const entry = agent?.mcpServers?.find((e) => entryName(e) === proposal.server);
  const config = resolveServer(proposal.server, agent?.id, undefined, entry);
  if (!config) return fail(`"${proposal.server}" is not a server this deployment declares.`);

  let mcp: ConnectedMcp | undefined;
  try {
    mcp = await connectMcpServers([config]);
    if (!mcp.details.some((t) => t.name === proposal.tool)) {
      return fail(`"${proposal.server}" no longer offers "${proposal.tool}" to this credential.`);
    }
    const out = await mcp.execute(proposal.tool, proposal.args);
    if (out.startsWith("Tool error:")) return fail(out);
    await finishProposal(id, { result: out });
    return { ok: true, proposal: (await getProposal(id))! };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    await mcp?.close().catch(() => {});
  }
}
