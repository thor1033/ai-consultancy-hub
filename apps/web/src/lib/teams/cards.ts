import type { Approval } from "@ai-hub/db";

/*
 * The approval card.
 *
 * This is the gate as a person meets it. Everything the hub knows about the
 * action is already in the row; the job here is to show enough that pressing
 * Approve is an informed act rather than a reflex — who it goes to, what it
 * says, and that it has not been sent yet.
 *
 * `Action.Submit`, not `Action.Execute`. Submit arrives as an ordinary message
 * activity carrying `value`, which is one code path in handler.ts and one shape
 * to verify. Execute's universal-action invoke refreshes the card for everyone
 * automatically, which is nicer, but it is a second protocol to get right blind
 * — and the card is replaced on decision anyway (connector.replaceCard), so the
 * buttons do not linger either way.
 */

const PREVIEW_LIMIT = 900;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const fact = (title: string, value: string) => ({ title, value });

/** The card a person decides on. */
export function approvalCard(approval: Approval): unknown {
  const a = approval.action ?? {};
  const to = list(a.to);
  const cc = list(a.cc);
  const preview = str(a.preview);

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Waiting to be sent",
        weight: "Bolder",
        size: "Medium",
        wrap: true,
      },
      { type: "TextBlock", text: approval.summary, wrap: true, spacing: "Small" },
      {
        type: "FactSet",
        facts: [
          fact("To", to.join(", ") || "—"),
          ...(cc.length ? [fact("Cc", cc.join(", "))] : []),
          fact("Subject", str(a.subject, "—")),
        ],
      },
      ...(preview
        ? [
            {
              type: "TextBlock",
              text: preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}…` : preview,
              wrap: true,
              isSubtle: true,
              spacing: "Medium",
            },
          ]
        : []),
      {
        type: "TextBlock",
        // Both halves matter: that nothing has happened yet, and that editing is
        // a real option rather than a choice between send-as-is and reject.
        text: "This is a draft in Outlook — nothing has been sent. Edit it there first if it needs changing; Approve sends whatever the draft says at that moment.",
        wrap: true,
        isSubtle: true,
        size: "Small",
        spacing: "Medium",
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Approve and send",
        style: "positive",
        data: { approvalId: approval.id, decision: "approved" },
      },
      {
        type: "Action.Submit",
        title: "Reject",
        data: { approvalId: approval.id, decision: "rejected" },
      },
    ],
  };
}

/**
 * The card that replaces it once decided.
 *
 * No buttons: the decision is made, and a live button on a decided row invites
 * a second press that can only be refused.
 */
export function decidedCard(approval: Approval, outcome: string): unknown {
  const a = approval.action ?? {};
  const rejected = approval.state === "rejected";
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: rejected ? "Rejected" : "Approved",
        weight: "Bolder",
        size: "Medium",
        color: rejected ? "Attention" : "Good",
        wrap: true,
      },
      { type: "TextBlock", text: approval.summary, wrap: true, spacing: "Small" },
      {
        type: "FactSet",
        facts: [
          fact("To", list(a.to).join(", ") || "—"),
          fact("Subject", str(a.subject, "—")),
          fact("Decided by", approval.decidedBy ?? "—"),
        ],
      },
      { type: "TextBlock", text: outcome, wrap: true, spacing: "Medium" },
    ],
  };
}
