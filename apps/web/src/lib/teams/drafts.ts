/*
 * Finding the drafts a run wrote.
 *
 * When the secretary answers "reply to Anna and say Friday works", it calls
 * m365_mail_draft and a real draft appears in Outlook. Something then has to
 * park that as an approval — and the question is which half of the system does
 * it.
 *
 * Not the MCP server. It runs as a child process inside the tool loop and has
 * no idea whose request this is, and giving it the principal would put the
 * decision of what needs approving inside the thing being gated.
 *
 * So it happens here, afterwards, by reading what the run actually did. The
 * transcript is already stored on every run (agent_sessions.transcript, the
 * full Anthropic message array), so the tool results are on record whether or
 * not the model mentioned them in its answer — which matters, because a model
 * that forgets to say it wrote a draft must not be able to lose the approval.
 */

/** One draft the run created, as the approval card will show it. */
export interface DraftWritten {
  draftId: string;
  subject: string;
  to: string[];
  cc: string[];
  preview: string;
  openInOutlook: string | null;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Tool results arrive as a string, or as a list of content blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: string }).type === "text"
        ? asString((block as { text?: unknown }).text)
        : "",
    )
    .join("\n");
}

// The tool answers with a JSON object, but a failed call answers with prose, so
// parsing is attempted and a miss is simply not a draft.
function parsed(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Every draft created during one run, oldest first.
 *
 * Matched by tool_use id rather than by position: a run can write several
 * drafts, and Anthropic's message array interleaves them with other tool calls.
 */
export function draftsInTranscript(transcript: unknown[]): DraftWritten[] {
  const draftCallIds = new Set<string>();
  const found: DraftWritten[] = [];

  for (const message of transcript) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;

      if (b.type === "tool_use" && b.name === "m365_mail_draft" && typeof b.id === "string") {
        draftCallIds.add(b.id);
        continue;
      }

      if (b.type === "tool_result" && typeof b.tool_use_id === "string" && draftCallIds.has(b.tool_use_id)) {
        // An errored call is not a draft. The model was told so at the time;
        // this must not turn it into an approval anyway.
        if (b.is_error === true) continue;
        const payload = parsed(resultText(b.content));
        const draftId = asString(payload?.draftId);
        if (!payload || !draftId) continue;

        found.push({
          draftId,
          subject: asString(payload.subject),
          to: Array.isArray(payload.to) ? payload.to.map(asString).filter(Boolean) : [],
          cc: Array.isArray(payload.cc) ? payload.cc.map(asString).filter(Boolean) : [],
          // The tool does not return the body — it returns what Graph stored.
          // The summary the model wrote is the preview a person reads, and the
          // draft itself is one click away in Outlook.
          preview: asString(payload.preview),
          openInOutlook: asString(payload.openInOutlook) || null,
        });
      }
    }
  }

  // The same draft twice (a retried call) would be two cards for one action.
  const seen = new Set<string>();
  return found.filter((d) => (seen.has(d.draftId) ? false : (seen.add(d.draftId), true)));
}
