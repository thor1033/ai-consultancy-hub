// Brief health (docs/effective-agents-review.md, B1): what Anthropic's
// context-engineering advice would say about a brief, as hints beside the
// word count. Pure and client-safe, so the form can say it while a person
// types and the design tools can say it in their answer.
//
// The advice, in short: the smallest set of high-signal words that does the
// job, because every word is read on every turn; headed sections; one or two
// examples rather than a list of hard rules; and no reference to a tool the
// agent has not got, which the model would try to use anyway.
//
// Hints, never refusals: a brief is the champion's, and a long one is
// sometimes right. The form saves whatever is typed.

export interface BriefHealthInput {
  instructions: string;
  /** Tool servers the agent is given, by name. */
  servers: string[];
  /** Every tool server this hub has, so a mention of one not given can be spotted. */
  catalog: { name: string; label: string }[];
  keepsMemory: boolean;
  /** Agents it may ask, by slug. */
  asks: string[];
}

export interface BriefHealth {
  words: number;
  /** Approximate: four characters a token. The run page measures the real figure. */
  tokens: number;
  hints: string[];
}

/** Words that mark a hard rule. Counted, not forbidden. */
const ABSOLUTE = /\b(always|never)\b/gi;
/** A heading: Markdown, or a short line ending in a colon on its own. */
const HEADING = /^(#{1,4}\s+\S|[A-Z][^\n]{1,48}:\s*$)/m;

export function briefHealth(input: BriefHealthInput): BriefHealth {
  const text = input.instructions;
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const tokens = Math.round(text.length / 4);
  const hints: string[] = [];
  if (!trimmed) return { words, tokens, hints };

  if (tokens > 3000) {
    hints.push(`About ${tokens.toLocaleString("en-GB")} tokens, read again on every turn of every run. Keep the brief to what every run needs; reference material belongs in documents the agent retrieves when it needs them.`);
  } else if (tokens > 1500) {
    hints.push(`About ${tokens.toLocaleString("en-GB")} tokens, read again on every turn. Worth a pass for anything a document could hold instead.`);
  }

  if (words >= 120 && !/\bexample\b|\be\.g\.|for instance|such as:|like this:/i.test(text)) {
    hints.push("No example of a good answer. One short example teaches the model more than ten rules about the answer.");
  }

  if (words >= 150 && !HEADING.test(text)) {
    hints.push("No headed sections. Headings (## What you do, ## What you must not do) help the model find the right rule when it needs it.");
  }

  const given = new Set(input.servers.map((s) => s.toLowerCase()));
  for (const server of input.catalog) {
    if (given.has(server.name.toLowerCase())) continue;
    const names = [server.name, server.label].filter((n) => n && n.length >= 3);
    if (names.some((n) => new RegExp(`(^|[^a-z0-9_])${escape(n)}([^a-z0-9_]|$)`, "i").test(text))) {
      hints.push(`Mentions ${server.label || server.name}, but is not given it under What it may use. The model will try to use what the brief names.`);
    }
  }

  if (!input.keepsMemory && /\bmemor(y|ies)\b|memory_list|memory_write/i.test(text)) {
    hints.push("Talks about memory, but keeps none: it starts every run with nothing but this brief and its prompt.");
  }

  if (input.asks.length === 0 && /agents_ask|\bask (the|another) \w+ agent\b/i.test(text)) {
    hints.push("Says to ask another agent, but may ask nobody. Tick the agents it may ask under What it may use.");
  }

  const absolutes = (text.match(ABSOLUTE) ?? []).length;
  if (absolutes >= 6 && absolutes / Math.max(words, 1) > 0.012) {
    hints.push(`${absolutes} absolute rules (always, never). A brief that is mostly hard rules is brittle; say what a good answer looks like, and keep the rules for real boundaries.`);
  }

  return { words, tokens, hints };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
