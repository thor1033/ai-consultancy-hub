import {
  createApproval,
  getApproval,
  attachApprovalOrigin,
  decideApproval,
  recordApprovalOutcome,
  getSession,
  type Approval,
} from "@ai-hub/db";
import { runAgentForPrincipal } from "@/lib/agentRuns";
import { sendApprovedDraft } from "@/lib/mail/send";
import { say, showCard, replaceCard, type ThreadRef } from "./connector";
import { approvalCard, decidedCard } from "./cards";
import { principalForTeamsUser } from "./identity";
import { draftsInTranscript } from "./drafts";

/*
 * What the bot does when something arrives.
 *
 * Two shapes reach here, and they are deliberately not the same code path:
 *
 *   a MESSAGE      someone @mentioned the bot. Resolve who they are, run the
 *                  agent as them, and report back. Minutes, not seconds.
 *   a CARD ACTION  someone pressed Approve or Reject. Decide the row, carry the
 *                  action out, and replace the card. Fast, and the only path
 *                  that causes anything to leave the tenant.
 *
 * TIME is the constraint that shapes the first one. Teams expects the HTTP 200
 * within seconds and an agent run takes minutes, so the run cannot happen
 * inside the request. It is started and the response goes out; the container is
 * long-lived (the same reasoning as agentRuns.ts and the scheduler), so the
 * work finishes afterwards and reports itself into the thread. That background
 * promise is returned rather than dropped, so a test can await what a route
 * deliberately does not.
 */

export interface InboundActivity {
  type?: string;
  id?: string;
  text?: string;
  value?: Record<string, unknown>;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: { id?: string };
  serviceUrl?: string;
  recipient?: { id?: string; name?: string };
  membersAdded?: { id?: string }[];
}

export interface Handled {
  kind: "message" | "decision" | "greeting" | "ignored" | "refused";
  detail: string;
  /** Work that outlives the HTTP response. Awaited by the verifier, not the route. */
  background?: Promise<void>;
}

/** Which agent answers in the channel. */
const agentSlug = () => process.env.TEAMS_AGENT || "secretary";

/**
 * Strip the @mention.
 *
 * Teams delivers the mention as literal text — "<at>Secretary</at> what is on
 * today?" — and passing that through means the agent reads its own name as part
 * of the question.
 */
export function withoutMention(text: string, botName?: string): string {
  let out = text.replace(/<at>[\s\S]*?<\/at>/gi, " ");
  if (botName) out = out.replace(new RegExp(`(^|\\s)@?${botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
  return out.replace(/\s+/g, " ").trim();
}

const threadOf = (a: InboundActivity): ThreadRef => ({
  serviceUrl: a.serviceUrl ?? "",
  conversationId: a.conversation?.id ?? "",
  replyToId: a.id,
});

/** One line summarising a draft, for the card's headline and the fallback text. */
const summarise = (d: { subject: string; to: string[] }) =>
  `Reply to ${d.to.join(", ") || "an unnamed recipient"} — ${d.subject || "no subject"}`;

// ── a message ────────────────────────────────────────────────────────────────

async function runAndReport(
  thread: ThreadRef,
  activity: InboundActivity,
  prompt: string,
): Promise<void> {
  const who = await principalForTeamsUser(thread, activity.from);
  if (!who.ok) {
    await say(thread, who.reason);
    return;
  }

  const outcome = await runAgentForPrincipal({
    agentRef: agentSlug(),
    prompt,
    principal: who.principal,
    // Wait for the whole run: nothing is holding an HTTP connection open by
    // now, and a partial answer in a channel is worse than a slow one.
    deadlineMs: 10 * 60_000,
  });

  if (outcome.kind === "error") {
    await say(thread, outcome.message);
    return;
  }
  if (outcome.kind === "running") {
    await say(thread, "That is taking longer than expected — it is still running, and I will not be able to report back on it here.");
    return;
  }

  await say(thread, outcome.output);

  // Anything the run drafted is parked for a person, one card each. Read from
  // the stored transcript rather than from the answer text, so a model that
  // forgot to mention a draft cannot lose the approval.
  const session = await getSession(outcome.runId);
  for (const draft of draftsInTranscript(session?.transcript ?? [])) {
    const parked = await createApproval({
      kind: "mail.send",
      sessionId: outcome.runId,
      requestedBy: who.principal.id,
      summary: summarise(draft),
      action: { ...draft },
      origin: { kind: "teams", conversationId: thread.conversationId, serviceUrl: thread.serviceUrl },
    });
    if ("error" in parked) {
      await say(thread, `I wrote a draft but could not park it for approval: ${parked.error}`);
      continue;
    }
    const cardId = await showCard(thread, approvalCard(parked), summarise(draft));
    // Stamped after posting, because the card's id does not exist until then.
    // It is what lets the decision replace this card rather than leave live
    // buttons on a settled row.
    if (cardId) await attachApprovalOrigin(parked.id, { ...(parked.origin ?? {}), activityId: cardId });
  }
}

// ── a decision ───────────────────────────────────────────────────────────────

/** Carry out an approved action. Only `mail.send` exists. */
async function carryOut(approval: Approval): Promise<string> {
  if (approval.kind !== "mail.send") {
    return `I do not know how to carry out a "${approval.kind}" action, so nothing happened.`;
  }
  const result = await sendApprovedDraft(approval.action);
  if (!result.ok) {
    await recordApprovalOutcome(approval.id, { failure: result.error });
    return `Approved, but not sent: ${result.error}`;
  }
  await recordApprovalOutcome(approval.id, { result: { ...result.sent } });
  const edited = result.sent.editedAfterProposal
    ? " (the draft had been edited since it was proposed — what was sent is what the draft said)"
    : "";
  return `Sent to ${result.sent.to.join(", ")}${edited}.`;
}

async function decideFromCard(thread: ThreadRef, activity: InboundActivity): Promise<void> {
  const value = activity.value ?? {};
  const approvalId = typeof value.approvalId === "string" ? value.approvalId : "";
  const decision = value.decision === "approved" ? "approved" : "rejected";

  const who = await principalForTeamsUser(thread, activity.from);
  if (!who.ok) {
    await say(thread, who.reason);
    return;
  }

  const outcome = await decideApproval({ id: approvalId, decision, decidedBy: who.principal.id });

  if (!outcome.ok) {
    // Four reasons, four different things a person needs to hear. "Someone
    // already approved this" and "this is too old to send now" are not the same
    // news, and neither is a plain failure.
    const message =
      outcome.reason === "already-decided"
        ? `${outcome.approval.decidedBy} already ${outcome.approval.state} this one — nothing has changed.`
        : outcome.reason === "expired"
          ? "That has been waiting too long to send now. The draft is still in Outlook if it is still wanted — ask me again and I will write a fresh one."
          : outcome.reason === "not-found"
            ? "I cannot find that approval any more."
            : "You are not permitted to decide that.";
    await say(thread, message);
    return;
  }

  const approval = outcome.approval;
  const result =
    decision === "approved" ? await carryOut(approval) : "Rejected — nothing was sent, and the draft is still in Outlook.";

  // Replace the original card so the buttons are gone for everyone, not just
  // for whoever pressed one.
  const activityId = typeof approval.origin?.activityId === "string" ? approval.origin.activityId : null;
  const replaced = activityId
    ? await replaceCard(thread, activityId, decidedCard(await refresh(approval), result), result)
    : false;
  if (!replaced) await say(thread, result);
}

/** Re-read so the card shows the outcome columns the decision just wrote. */
const refresh = async (approval: Approval): Promise<Approval> => (await getApproval(approval.id)) ?? approval;

// ── the door ─────────────────────────────────────────────────────────────────

export async function handleActivity(activity: InboundActivity): Promise<Handled> {
  const thread = threadOf(activity);
  if (!thread.serviceUrl || !thread.conversationId) {
    return { kind: "ignored", detail: "no conversation to answer in" };
  }

  if (activity.type === "conversationUpdate") {
    const botId = activity.recipient?.id;
    const joined = (activity.membersAdded ?? []).some((m) => m.id && m.id === botId);
    if (!joined) return { kind: "ignored", detail: "membership change that is not the bot joining" };
    return {
      kind: "greeting",
      detail: "introduced itself",
      background: say(
        thread,
        "I am the secretary. Mention me with a question about the mailbox, the calendar or the project board. " +
          "If I write a reply for you it goes to Drafts and waits here for someone to approve it — I cannot send anything myself.",
      ).then(() => undefined),
    };
  }

  if (activity.type !== "message") return { kind: "ignored", detail: `activity type ${activity.type}` };

  // An Action.Submit press arrives as a message with `value` and no text.
  if (activity.value && typeof activity.value.approvalId === "string") {
    return { kind: "decision", detail: activity.value.approvalId, background: decideFromCard(thread, activity) };
  }

  const prompt = withoutMention(activity.text ?? "", activity.recipient?.name);
  if (!prompt) {
    return {
      kind: "refused",
      detail: "empty after the mention was stripped",
      background: say(thread, "Say what you would like me to do — mentioning me on its own tells me nothing.").then(() => undefined),
    };
  }

  return { kind: "message", detail: prompt.slice(0, 80), background: runAndReport(thread, activity, prompt) };
}
