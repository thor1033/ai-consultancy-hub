import type { Pattern } from "./index";

/*
 * One door — the front desk.
 *
 * People ask one agent; it works out which specialist the question is for,
 * passes it on with the context the asker gave, and returns the answer with
 * the specialist's name on it. Unlike the cluster, a question goes to one
 * specialist, not to all of them in parts: this is routing, not splitting.
 * The front desk remembers who asks about what, which is how it gets better
 * at routing and how it notices an area nobody covers.
 */
export const FRONT_DESK: Pattern = {
  slug: "front-desk",
  name: "One door, many specialists",
  nickname: "Front desk",
  summary:
    "One agent people ask, which routes each question to the one specialist it is for and returns the answer with the specialist's name on it.",
  when: [
    "People should not have to know which agent to ask.",
    "The areas are distinct enough that a question belongs to one of them.",
    "You want to learn what people ask for, and what nobody covers yet.",
  ],
  diagram: `person ──▶ Front desk ──(which area?)──▶ one Specialist ──▶ answer
                 │                                      (named in the reply)
                 └── remembers who asks about what, and what nobody covers`,
  decisions: [
    "Tell people the front desk's name; it is the only agent they need to know.",
    "Read its memory after a week: the “nobody covers” list is your next specialist.",
    "Give each specialist the tool servers and knowledge of its area, on its page.",
  ],
  params: [
    {
      key: "askers",
      label: "Who asks",
      help: "Who the front desk serves, and through what.",
      kind: "text",
      required: true,
      placeholder: "Colleagues, from Claude Code and Teams",
    },
    {
      key: "specialists",
      label: "Specialists",
      help: "One per line, written “Name: what they cover”. Each becomes an agent.",
      kind: "list",
      required: true,
      placeholder: "IT: laptops, accounts, access\nHR: leave, contracts, expenses\nProjects: what is on the board and who owns it",
    },
  ],
  roles: (v, lists) => {
    const specialists = lists.specialists;
    const roster = specialists.map((s) => `- ${s.name} ({{agent:${s.key}}}): ${s.text}`).join("\n");
    return [
      {
        key: "front-desk",
        name: "Front desk",
        description: "The one agent {{askers}} ask. Routes each question to the specialist it is for, and names them in the answer.",
        keepsMemory: true,
        asks: specialists.map((s) => s.key),
        maxIterations: 12,
        instructions: `You are the Front desk of "{{instance}}", the one agent ${v.askers} ask.
You do not answer questions yourself; you find the specialist a question is
for, pass it on, and return the answer with their name on it.

The specialists, and what each covers:
${roster}

## How you work

1. memory_list: who asked about what before, and what nobody covers.
2. Decide which ONE specialist the question is for. Pass it on with
   agents_ask: the question as asked, plus the context the asker gave
   (copied in — the specialist sees nothing else).
   - If it is plainly for two specialists, ask both, each their part, and say
     in the answer which answered which.
   - If it is about this desk itself (what can you do, who is there), answer
     from the roster above.
   - If no specialist covers it, say so, name the areas you do have, and
     memory_write the gap under "nobody-covers" so it is noticed.
3. Return the specialist's answer, with their name on it, without rewriting
   it. If they said something was missing, say so and what.
4. memory_write what helps you route next time: a kind of question that
   belongs to an area it did not look like, and who tends to ask about what.

## Rules

- You never answer within a specialist's area yourself, even if you could.
- You never send a specialist a question outside their area to see what
  happens.
- Writes a specialist proposes wait for a person's approval; say which
  specialist proposed what.`,
        memories: [
          {
            key: "nobody-covers",
            content: "Questions nobody covered yet, one line each with who asked. Empty so far.",
          },
        ],
      },
      ...specialists.map((s) => ({
        key: s.key,
        name: s.name,
        description: `The ${s.name} specialist of {{instance}}: ${s.text}.`,
        keepsMemory: true,
        maxIterations: 12,
        instructions: `You are the ${s.name} specialist of "{{instance}}". Your area:
${s.text}

Questions reach you from the Front desk ({{name:front-desk}}) with the
context the asker gave, and from people directly. Either way:

- Answer within your area, precisely, with the evidence: where a fact comes
  from (a tool's result, a document, your memory), and how sure you are.
- When part of a question is outside your area, say which part and that it is
  not yours; do not answer it anyway.
- When the context given is not enough to answer, say exactly what is
  missing. Do not guess it.
- memory_list at the start; memory_write what you learn about your area that
  will be true next time (a fact, a correction, a definition), one per key.
- A write you propose through a tool waits for a person's approval; say so.`,
      })),
    ];
  },
};
