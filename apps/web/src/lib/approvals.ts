import type { Principal } from "@ai-hub/authz";
import { authorize } from "@ai-hub/authz";
import {
  assignProposal,
  claimProposal,
  createProposal,
  finishProposal,
  getAgent,
  getPrincipal,
  getProposal,
  listPeople,
  rejectProposal,
  type McpEntry,
  type PrincipalRow,
  type Proposal,
} from "@ai-hub/db";
import { connectMcpServers, type ConnectedMcp, type McpToolInfo } from "@ai-hub/mcp";
import { isReadOnlyTool } from "@/lib/mcp/proxyTools";
import { attachImages, IMAGES_ARG, IMAGES_SCHEMA, readImageRequests } from "@/lib/proposalImages";
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
 *
 * THE REASON LINE. A held call shows the approver its tool and arguments —
 * and `status: inprogress, taskId: t_ft87883` says nothing about why. So the
 * gate adds one argument, `reason`, to the schema of every tool it will hold,
 * described to the model as the line a person reads before approving. It is
 * taken out of the arguments before the call is recorded, so the upstream
 * never sees it and what runs on approval is exactly what the upstream
 * declared; it is stored on the proposal and shown beside the arguments. A
 * call without one is still held — the gate does not refuse a write for
 * lacking a sentence — it just reads worse on /approvals.
 *
 * IMAGES. Beside the reason, the gate adds an optional `images` argument: up
 * to four pictures the approver should look at (a screenshot of the finished
 * work, the chart a change rests on). Taken off the arguments the same way,
 * fetched or decoded and stored as bytes when the call is held
 * (lib/proposalImages.ts), so the approver sees what the agent saw. An image
 * that cannot be attached never stops the write from being held; the model is
 * told which one and why.
 */

export const REASON_ARG = "reason";
const REASON_DESCRIPTION =
  "For the person who approves this on the hub's Approvals page: one or two sentences saying what this changes and the evidence " +
  "(a transcript time and quote, a commit, who asked). Required for every write. It is not sent to the tool.";

type ToolDef = ConnectedMcp["tools"][number];

/** Whether the upstream itself declares a `reason` argument, in which case the hub leaves it alone. */
function upstreamOwnsReason(tool: Pick<McpToolInfo, "inputSchema">): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Boolean(props && Object.prototype.hasOwnProperty.call(props, REASON_ARG));
}

/** Whether the upstream itself declares an `images` argument, in which case the hub leaves it alone. */
function upstreamOwnsImages(tool: Pick<McpToolInfo, "inputSchema">): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Boolean(props && Object.prototype.hasOwnProperty.call(props, IMAGES_ARG));
}

/** The JSON Schema of a held tool: the reason line added and required, the optional images beside it. */
export function withReasonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const props = ((schema.properties as Record<string, unknown> | undefined) ?? {});
  const ownsReason = Object.prototype.hasOwnProperty.call(props, REASON_ARG);
  const ownsImages = Object.prototype.hasOwnProperty.call(props, IMAGES_ARG);
  if (ownsReason && ownsImages) return schema;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    ...schema,
    type: "object",
    properties: {
      ...props,
      ...(ownsReason ? {} : { [REASON_ARG]: { type: "string", description: REASON_DESCRIPTION } }),
      ...(ownsImages ? {} : { [IMAGES_ARG]: IMAGES_SCHEMA }),
    },
    required: ownsReason ? required : [...required, REASON_ARG],
  };
}

/** The upstream tool, as the model should see it when its calls are held. */
export function withReason(tool: McpToolInfo): McpToolInfo {
  return upstreamOwnsReason(tool) && upstreamOwnsImages(tool) ? tool : { ...tool, inputSchema: withReasonSchema(tool.inputSchema) };
}

/** Split the reason and the images the gate asked for off the arguments the upstream declared. */
export function takeReason(
  tool: Pick<McpToolInfo, "inputSchema">,
  input: unknown,
): { args: Record<string, unknown>; reason: string | null; images: unknown } {
  const args = (input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {}) as Record<string, unknown>;
  let reason: string | null = null;
  let images: unknown = undefined;
  if (!upstreamOwnsReason(tool)) {
    const raw = args[REASON_ARG];
    delete args[REASON_ARG];
    reason = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  }
  if (!upstreamOwnsImages(tool)) {
    images = args[IMAGES_ARG];
    delete args[IMAGES_ARG];
  }
  return { args, reason, images };
}

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
export function heldText(proposal: Pick<Proposal, "id" | "tool" | "server"> & { images?: unknown[]; imageNotes?: string[] }): string {
  const shown = proposal.images?.length ?? 0;
  const notes = proposal.imageNotes ?? [];
  return (
    `HELD FOR APPROVAL. \`${proposal.tool}\` (${proposal.server}) was NOT executed. ` +
    `It is recorded as proposal ${proposal.id} and a person must approve it on the hub's Approvals page ` +
    `before it happens. Carry on as if it has not happened: do not retry it, do not assume its effect, ` +
    `and tell the reader exactly what you proposed and that it awaits approval.` +
    (shown ? ` ${shown} image${shown === 1 ? " is" : "s are"} attached for the approver.` : "") +
    // Said to the model so it ends up in the answer a person reads: an image
    // that silently failed would leave the approver deciding without it.
    (notes.length ? ` Not every image could be attached: ${notes.join(" ")} You may attach a corrected one with hub_attach_image.` : "")
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
 * The tool list the model sees, and the executor behind it.
 *
 * Read tools pass straight through, writes become proposals, and every tool
 * whose calls will be held carries the reason line in its schema — the two
 * halves agree because they are decided by the same `needsApproval`.
 */
export function gate(mcp: ConnectedMcp, ctx: GateContext): { tools: ToolDef[]; execute: ConnectedMcp["execute"] } {
  const byName = new Map(mcp.details.map((t) => [t.name, t]));
  const entryFor = (server: string) => ctx.entries?.find((e) => entryName(e) === server);
  const isHeld = (tool: McpToolInfo | undefined) => Boolean(tool && needsApproval(tool, entryFor(tool.server)));

  const tools = mcp.tools.map((t) => {
    const detail = byName.get(t.name);
    if (!isHeld(detail) || upstreamOwnsReason(detail!)) return t;
    return { ...t, input_schema: withReasonSchema(t.input_schema as Record<string, unknown>) as ToolDef["input_schema"] };
  });

  const execute: ConnectedMcp["execute"] = async (name, input) => {
    const tool = byName.get(name);
    if (tool && isHeld(tool)) {
      const proposal = await hold(tool, input, ctx);
      ctx.held?.add(tool.name);
      return heldText(proposal);
    }
    return mcp.execute(name, input);
  };
  return { tools, execute };
}

/** The executor alone; the tool list is unchanged, so a held tool has no reason line. */
export function gatedExecutor(mcp: ConnectedMcp, ctx: GateContext): ConnectedMcp["execute"] {
  return gate(mcp, ctx).execute;
}

/**
 * Record a held call. Exported for the per-agent endpoint, which wraps calls
 * itself. The reason is taken off the arguments here, so a proposal's `args`
 * are always exactly what the upstream will receive.
 */
export async function hold(tool: McpToolInfo, input: unknown, ctx: GateContext): Promise<Proposal & { imageNotes: string[] }> {
  const { args, reason, images } = takeReason(tool, input);
  const proposal = await createProposal({
    agentId: ctx.agentId ?? null,
    runId: ctx.runId ?? null,
    principalId: ctx.principalId ?? null,
    server: tool.server,
    tool: tool.name,
    args,
    description: tool.description,
    reason,
  });
  const { requests, notes } = readImageRequests(images);
  if (!requests.length) return { ...proposal, imageNotes: notes };
  // The write is held first and the images follow: an image that fails to
  // fetch must never cost the person the write itself.
  const outcome = await attachImages(proposal.id, requests, ctx.principalId ?? null);
  return { ...((await getProposal(proposal.id)) ?? proposal), imageNotes: [...notes, ...outcome.notes] };
}

/**
 * Who may decide a proposal: an admin, the person whose reach the run had, or
 * the person it was sent to — and never an agent. A credential bound to an
 * agent is the agent's own key, and an agent approving its own writes is no
 * gate at all.
 *
 * Sending a proposal on adds a decider; it does not remove the one who sent
 * it. The person a run acted as can still decide their own run's writes after
 * handing them to a colleague, so a handoff to someone who is away never
 * strands a write.
 */
export async function mayDecide(principal: Principal, proposal: Proposal): Promise<boolean> {
  if (principal.agentId) return false;
  if (!(await authorize(principal, "agent:run"))) return false;
  if (await authorize(principal, "admin:manage")) return true;
  if (proposal.assignedTo && proposal.assignedTo === principal.id) return true;
  return Boolean(proposal.principalId) && proposal.principalId === principal.id;
}

/**
 * Who may add an image to a waiting proposal: anyone who may decide it, and
 * the agent that made it (through a credential bound to that agent) — adding
 * evidence is not deciding, and the agent is usually the one holding the
 * screenshot. Never another agent.
 */
export async function mayAttach(principal: Principal, proposal: Proposal): Promise<boolean> {
  if (principal.agentId) return Boolean(proposal.agentId) && proposal.agentId === principal.agentId;
  return mayDecide(principal, proposal);
}

/** A principal row as the policy engine sees a person. */
const asPrincipal = (row: PrincipalRow): Principal => ({
  id: row.id,
  roles: row.roles,
  source: "oauth",
  ...(row.email ? { email: row.email } : {}),
});

/**
 * Who a proposal can be sent to: a person (an enabled principal with an
 * email, not bound to an agent) whose role may run agents, and so may decide
 * a write. Someone who could not decide it would only be handed a dead end.
 */
export async function peopleToSendTo(principal: Principal): Promise<{ id: string; name: string; email: string }[]> {
  const out: { id: string; name: string; email: string }[] = [];
  for (const row of await listPeople()) {
    if (row.id === principal.id) continue;
    if (!(await authorize(asPrincipal(row), "agent:run"))) continue;
    out.push({ id: row.id, name: row.displayName || row.email!, email: row.email! });
  }
  return out;
}

/**
 * Send a pending proposal to someone else to decide, or take it back
 * (`to` null). Only someone who may decide it may pass it on — you cannot
 * hand over a decision that is not yours — and only to a person who could
 * decide it in turn.
 */
export async function sendOn(id: string, principal: Principal, to: string | null, note?: string): Promise<Decision> {
  const proposal = await getProposal(id);
  if (!proposal) return { error: "No such proposal." };
  if (!(await mayDecide(principal, proposal))) return { error: "You may not decide this proposal, so you cannot send it on." };
  if (proposal.status !== "pending") return { error: `This proposal is already ${proposal.status}.` };
  if (to !== null) {
    if (to === principal.id) return { error: "That is you: decide it here instead." };
    const row = await getPrincipal(to);
    if (!row || !row.enabled || !row.email || row.agentId) return { error: "That is not a person who can be sent a proposal." };
    if (!(await authorize(asPrincipal(row), "agent:run"))) {
      return { error: `${row.displayName || row.email}'s role cannot decide writes, so they could not act on it.` };
    }
  }
  if (!(await assignProposal(id, to, principal.id, note))) return { error: "This proposal was decided in the meantime." };
  return { ok: true, proposal: (await getProposal(id))! };
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
