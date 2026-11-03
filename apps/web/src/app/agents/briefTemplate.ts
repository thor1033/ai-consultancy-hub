// The brief template (docs/effective-agents-review.md, B2 and D2). Client-safe:
// text only.
//
// Anthropic's advice on a system prompt is to keep it at the right altitude —
// not a list of hard rules, not vague guidance — in headed sections, with a
// few examples rather than many edge cases, and to grow it only in response
// to failures seen. The seeded agents' briefs have this shape; this is the
// skeleton of it for someone writing their first. The last section is the
// self-check from the harness post: say what you did not do.

export const BRIEF_TEMPLATE = `## Who you are
You are … at …, working for … .

## What you do
One paragraph: the job, in plain words, and who reads the result.

## What a good answer looks like
The shape: length, language, format. Then ONE example of a good answer,
short, so you can match it.

## Where to look first
Which tool or documents to reach for, and what never to guess.

## What you must not do
Two or three lines. Each one a real boundary, not a style preference.

## Before you answer
Re-read the request. Say in one line what you did not do or could not
find, if anything. Never present a partial answer as complete.`;

/** The brief's words, for the readout beside it. */
export const wordCount = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);
