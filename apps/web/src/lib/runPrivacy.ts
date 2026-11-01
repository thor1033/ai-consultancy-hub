/*
 * Whose prompt a person may read (docs/data-protection-review.md, F3).
 *
 * A prompt is often the most sensitive line of a run — "draft the warning
 * letter to Peter about his absences" — and the run lists on Home, an agent's
 * page, a connection's page and a run's own page used to show everyone's to
 * everyone. Now a prompt's text is shown to the person the run was for, and to
 * admins; everyone else sees that a run happened, by whom, and how it went.
 *
 * Applied on the server, before the page renders: the text never reaches a
 * browser that may not show it, so it is not something a view or a client
 * component could leak. Errors are treated like prompts, since a failure can
 * quote what it was given.
 */

export interface RunViewer {
  /** The signed-in person's principal id, or null. */
  id: string | null;
  /** Admins read every prompt (until runs stop keeping them; phase 3 of the review). */
  admin: boolean;
}

interface RunLike {
  prompt: string;
  principalId: string | null;
  askedBy: string | null;
  error?: string | null;
}

export function mayReadPrompt(run: { principalId: string | null }, viewer: RunViewer): boolean {
  return viewer.admin || (viewer.id !== null && run.principalId === viewer.id);
}

/** The run as this viewer may see it: prompt and error emptied when it is not theirs to read. */
export function privateRun<T extends RunLike>(run: T, viewer: RunViewer): T & { promptHidden: boolean } {
  if (mayReadPrompt(run, viewer)) return { ...run, promptHidden: false };
  return { ...run, prompt: "", ...(run.error !== undefined ? { error: run.error ? "It did not finish." : null } : {}), promptHidden: true };
}

/** What a hidden prompt reads as. */
export function hiddenPromptLabel(run: { askedBy: string | null }): string {
  return run.askedBy ? `A run by ${run.askedBy}` : "A run by the hub";
}
