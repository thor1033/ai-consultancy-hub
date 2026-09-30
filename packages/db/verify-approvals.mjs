// Verification of approvals — the gate between an agent proposing an action and
// that action happening outside the hub.
//
//   node --env-file=apps/web/.env.local packages/db/verify-approvals.mjs
//
// No API key, no Microsoft tenant. Needs DATABASE_URL and the `approvals` table
// (npm run migrate -w @ai-hub/db). Everything happens under a throwaway agent
// and two throwaway principals that this script creates and deletes.
//
// What is actually being checked is not "a row can be written". It is the four
// properties that decide whether this gate holds when a real Teams channel is
// pressing the buttons:
//
//   one decision wins        two people pressing Approve in the same second
//   expiry is enforced       by the UPDATE, not by a sweeper that may not run
//   revocation reaches it    a disabled principal cannot approve
//   the decision and the     an approved send that failed is still approved
//     delivery stay apart
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith(".") || !context.parentURL) throw err;
      for (const ext of [".ts", ".mjs", ".js", "/index.ts"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      throw err;
    }
  },
});

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — run with --env-file=apps/web/.env.local");
  process.exit(1);
}

const {
  createApproval, getApproval, listApprovals, decideApproval,
  recordApprovalOutcome, expireStaleApprovals, DEFAULT_APPROVAL_TTL_MINUTES,
} = await import("./src/approvals.ts");
const { createAgent, deleteAgent } = await import("./src/agents.ts");
const { upsertPrincipal, setPrincipalEnabled } = await import("./src/credentials.ts");
const { getSql } = await import("./src/client.ts");

const sql = getSql();
const stamp = Date.now();
const asker = `verify-appr-asker-${stamp}`;
const approver = `verify-appr-approver-${stamp}`;
let agent = null;

// The shape a mail.send approval actually carries: the draft it will send, and
// enough of the draft for a person to decide without opening Outlook.
const mailAction = (over = {}) => ({
  draftId: "draft-abc",
  to: ["anna@example.com"],
  subject: "Re: Can we move Thursday?",
  preview: "Thursday afternoon does not work — would Friday 10:00 suit you?",
  ...over,
});

try {
  agent = await createAgent({ slug: `verify-appr-${stamp}`, name: "Verify Approvals" });
  await upsertPrincipal({ id: asker, displayName: "Verify Asker", roles: ["analyst"] });
  await upsertPrincipal({ id: approver, displayName: "Verify Approver", roles: ["analyst"] });

  // ── what gets stored ───────────────────────────────────────────────────────
  const made = await createApproval({
    kind: "mail.send",
    agentId: agent.id,
    requestedBy: asker,
    summary: "Reply to Anna Holm: Friday 10:00 instead of Thursday",
    action: mailAction(),
    origin: { kind: "teams", conversationId: "19:meeting_abc@thread.v2", activityId: "1758000000000" },
  });
  check("createApproval parks a pending action", made?.state === "pending", made?.id?.slice(0, 8) ?? JSON.stringify(made));
  check(
    "the action round-trips literally — what is approved is what gets carried out",
    made.action?.draftId === "draft-abc" && made.action.to?.[0] === "anna@example.com",
    JSON.stringify(made.action?.to),
  );
  check(
    "the origin round-trips, so a decision can be answered where it was asked",
    made.origin?.conversationId === "19:meeting_abc@thread.v2",
    made.origin?.kind,
  );
  check(
    `an expiry is set without being asked for (default ${DEFAULT_APPROVAL_TTL_MINUTES} minutes)`,
    Math.abs((new Date(made.expiresAt) - Date.now()) / 60000 - DEFAULT_APPROVAL_TTL_MINUTES) < 2,
    made.expiresAt,
  );
  check("nothing is carried out at creation", made.carriedOutAt === null && made.result === null);
  // The refusal shape must not overlap the row's own fields. It did once: the
  // row carried an `error` column, so `"error" in outcome` was true for every
  // successful create and every caller took the failure branch.
  check(
    "a successful create cannot be mistaken for a refusal",
    !("error" in made),
    Object.keys(made).filter((k) => k === "error").join() || "no overlapping field",
  );

  // ── refusing rows nobody could act on ──────────────────────────────────────
  const noSummary = await createApproval({ kind: "mail.send", requestedBy: asker, summary: "  ", action: mailAction() });
  check("an approval with no summary is refused — there is nothing to decide on", Boolean(noSummary.error), noSummary.error);
  const noAction = await createApproval({ kind: "mail.send", requestedBy: asker, summary: "Send it", action: {} });
  check("an empty action is refused — there would be nothing to carry out", Boolean(noAction.error), noAction.error);
  const badTtl = await createApproval({ kind: "mail.send", requestedBy: asker, summary: "x", action: mailAction(), ttlMinutes: 0 });
  check("a time to live of 0 is refused", Boolean(badTtl.error), badTtl.error);

  check("listApprovals finds it for the agent", (await listApprovals({ agentId: agent.id })).length === 1);
  check("and can be narrowed to what is still pending", (await listApprovals({ agentId: agent.id, state: "pending" })).length === 1);

  // ── one decision wins ──────────────────────────────────────────────────────
  // The case this exists for: a card in a channel where two people press
  // Approve at once. Both calls run; only one may decide, or the mail is sent
  // twice.
  const [a, b] = await Promise.all([
    decideApproval({ id: made.id, decision: "approved", decidedBy: approver }),
    decideApproval({ id: made.id, decision: "approved", decidedBy: asker }),
  ]);
  check("exactly one of two simultaneous decisions wins", a.ok !== b.ok, `${a.ok} / ${b.ok}`);
  const loser = a.ok ? b : a;
  check(
    "the loser is told it was already decided, and by whom",
    loser.reason === "already-decided" && Boolean(loser.approval?.decidedBy),
    `${loser.reason} by ${loser.approval?.decidedBy?.slice(-8)}`,
  );

  const decided = await getApproval(made.id);
  check("the decision records who and when", decided.state === "approved" && decided.decidedAt !== null, decided.decidedBy?.slice(-8));

  // ── the decision and the delivery are different facts ──────────────────────
  const failedSend = await recordApprovalOutcome(made.id, { failure: "Graph 403 ErrorAccessDenied: Mail.Send not consented" });
  check("a failed delivery is recorded against the approval", /Mail.Send/.test(failedSend?.failure ?? ""), failedSend?.failure?.slice(0, 40));
  check(
    "and it stays APPROVED — a send that failed is not a rejection",
    failedSend.state === "approved" && failedSend.carriedOutAt !== null,
    failedSend.state,
  );
  check(
    "an action already carried out is not carried out twice",
    (await recordApprovalOutcome(made.id, { result: { messageId: "sent-again" } })) === null,
  );

  // A successful one, on a second row, records what the outside world actually
  // did — which is how a draft edited in Outlook after approval stays visible.
  const second = await createApproval({
    kind: "mail.send", agentId: agent.id, requestedBy: asker,
    summary: "Reply to Accounts about invoice 4417", action: mailAction({ draftId: "draft-def" }),
  });
  await decideApproval({ id: second.id, decision: "approved", decidedBy: approver });
  const sent = await recordApprovalOutcome(second.id, {
    result: { sentAt: "2026-09-28T09:10:00Z", subject: "Re: Invoice 4417 overdue", to: ["accounts@supplier.example"] },
  });
  check(
    "a successful delivery records what was actually sent, not what was proposed",
    sent?.result?.subject === "Re: Invoice 4417 overdue" && sent.failure === null,
    sent?.result?.to?.join(),
  );

  // ── rejection ──────────────────────────────────────────────────────────────
  const toReject = await createApproval({
    kind: "mail.send", agentId: agent.id, requestedBy: asker,
    summary: "Reply declining the vendor call", action: mailAction({ draftId: "draft-ghi" }),
  });
  const rejected = await decideApproval({ id: toReject.id, decision: "rejected", decidedBy: approver, note: "I will answer this one myself" });
  check("an approval can be rejected with a note", rejected.ok && rejected.approval.state === "rejected", rejected.approval?.decisionNote);
  check(
    "a rejected action cannot then be carried out",
    (await recordApprovalOutcome(toReject.id, { result: { messageId: "x" } })) === null,
  );

  // ── revocation reaches it ──────────────────────────────────────────────────
  // Disabling a principal stops their schedules firing; it must also stop them
  // approving, or a departed colleague can still send mail from a channel.
  const whileDisabled = await createApproval({
    kind: "mail.send", agentId: agent.id, requestedBy: asker,
    summary: "Reply to the recruiter", action: mailAction({ draftId: "draft-jkl" }),
  });
  await setPrincipalEnabled(approver, false);
  const refused = await decideApproval({ id: whileDisabled.id, decision: "approved", decidedBy: approver });
  check("a disabled principal cannot approve", !refused.ok && refused.reason === "not-permitted", refused.reason);
  await setPrincipalEnabled(approver, true);
  check("and can again once re-enabled", (await decideApproval({ id: whileDisabled.id, decision: "approved", decidedBy: approver })).ok);

  // On a fresh pending row: against a decided one this would pass for the wrong
  // reason, reporting "already-decided" and never reaching the principal check.
  const forStranger = await createApproval({
    kind: "mail.send", agentId: agent.id, requestedBy: asker,
    summary: "Reply to the supplier", action: mailAction({ draftId: "draft-pqr" }),
  });
  const unknown = await decideApproval({ id: forStranger.id, decision: "approved", decidedBy: "nobody-by-that-name" });
  check(
    "a principal the hub does not know cannot approve",
    !unknown.ok && unknown.reason === "not-permitted",
    unknown.reason,
  );
  check("and the row is untouched by the attempt", (await getApproval(forStranger.id)).state === "pending");

  // ── expiry is enforced by the UPDATE, not by a sweeper ─────────────────────
  const stale = await createApproval({
    kind: "mail.send", agentId: agent.id, requestedBy: asker,
    summary: "Reply that has gone cold", action: mailAction({ draftId: "draft-mno" }), ttlMinutes: 1,
  });
  await sql`update approvals set expires_at = now() - interval '1 minute' where id = ${stale.id}`;
  const tooLate = await decideApproval({ id: stale.id, decision: "approved", decidedBy: approver });
  check(
    "an expired action cannot be approved even though nothing swept it",
    !tooLate.ok && tooLate.reason === "expired",
    tooLate.reason,
  );
  check("and it is still 'pending' in the row — expiry was not written by the read", (await getApproval(stale.id)).state === "pending");
  check("expireStaleApprovals then marks it, so a pending list stays actionable", (await expireStaleApprovals()) >= 1);
  check("after which it reads as expired", (await getApproval(stale.id)).state === "expired");

  const missing = await decideApproval({ id: "00000000-0000-0000-0000-000000000000", decision: "approved", decidedBy: approver });
  check("deciding something that does not exist says so rather than throwing", !missing.ok && missing.reason === "not-found");

  // ── lifetime ───────────────────────────────────────────────────────────────
  await deleteAgent(agent.id);
  agent = null;
  check(
    "deleting an agent takes its parked approvals with it",
    (await sql`select count(*)::int as n from approvals where id = ${made.id}`)[0].n === 0,
  );
} finally {
  if (agent) await deleteAgent(agent.id).catch(() => {});
  await sql`delete from approvals where requested_by in (${asker}, ${approver})`.catch(() => {});
  await sql`delete from principals where id in (${asker}, ${approver})`.catch(() => {});
  await sql.end();
}

const failedChecks = checks.filter((c) => !c.ok);
console.log(
  failedChecks.length === 0
    ? `\nApprovals OK (${checks.length} checks)`
    : `\nApprovals FAILED (${failedChecks.length}/${checks.length})`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
