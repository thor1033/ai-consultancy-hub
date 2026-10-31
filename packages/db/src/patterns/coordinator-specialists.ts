import type { Pattern } from "./index";

/*
 * Coordinator and specialists — the cluster.
 *
 * One question, several areas of expertise. The coordinator splits the
 * question by area, asks each specialist its part, and puts the answers
 * together with the seams showing: who said what, where two disagree, what
 * nobody could answer. Each specialist is a real agent with its own brief and
 * memory, so it gets better at its area, and a person can talk to it alone.
 */
export const COORDINATOR_SPECIALISTS: Pattern = {
  slug: "coordinator-specialists",
  name: "Coordinator and specialists",
  nickname: "Cluster",
  summary:
    "A coordinator that splits a question by area, asks each specialist its part, and answers with the seams showing: who said what, where they disagree, what nobody could answer.",
  when: [
    "A question needs several kinds of expertise at once (legal, delivery, the client's history).",
    "The areas are stable enough to name, and each is worth an agent that learns it.",
    "You want one place to ask, but you want to see which expert said which part.",
  ],
  diagram: `person ──▶ Coordinator
              │ splits the question, asks each
       ┌──────┼──────────┐
       ▼      ▼          ▼
  Specialist  Specialist  Specialist   (each: its area, its memory, its tools)
       └──────┴──────────┘
              ▼
      Coordinator reconciles, answers with sources`,
  decisions: [
    "Give each specialist the tool servers and knowledge collections of its area, on its page.",
    "Where two specialists keep disagreeing, that is a gap in the firm's own knowledge: file the answer.",
    "A specialist nobody asks for a month is an area that did not need an agent.",
  ],
  params: [
    {
      key: "job",
      label: "What the cluster is for",
      help: "The kind of question it answers, and for whom.",
      kind: "textarea",
      required: true,
      placeholder: "Scoping a new client engagement: what we would build, what it costs, what could go wrong.",
    },
    {
      key: "specialists",
      label: "Specialists",
      help: "One per line, written “Name: what they cover”. Each becomes an agent.",
      kind: "list",
      required: true,
      placeholder: "Legal: contracts, GDPR, what we may promise\nDelivery: effort, timeline, who would do it\nCommercial: price, margin, what the client has paid before",
    },
  ],
  roles: (_v, lists) => {
    const specialists = lists.specialists;
    const roster = specialists.map((s) => `- ${s.name} ({{agent:${s.key}}}): ${s.text}`).join("\n");
    return [
      {
        key: "coordinator",
        name: "Coordinator",
        description: "Splits a question of {{instance}} by area, asks the specialists, and answers with the seams showing.",
        keepsMemory: true,
        asks: specialists.map((s) => s.key),
        maxIterations: 25,
        instructions: `You are the Coordinator of "{{instance}}". You answer questions that need
more than one kind of expertise, by asking the specialists and putting their
answers together — never by answering for them.

What this cluster is for:
{{job}}

The specialists, and what each covers:
${roster}

## How you work

1. memory_list: what you learned about how to split such questions before.
2. Split the question by area. Write each specialist its own part: the
   question as it concerns their area, and the context they need (copied in;
   they cannot see what you were told unless you tell them). Do not send a
   specialist a part outside their area.
3. agents_ask each specialist you need, one at a time. Ask only the ones the
   question needs; a question for one area goes to one specialist.
4. Put the answers together with the seams showing:
   - each point says which specialist it came from;
   - where two disagree, say so, say which you would follow and why, and do
     not smooth it over;
   - what no specialist could answer is said as a gap, not filled by you.
5. memory_write anything that would make the next split better: a question
   that belongs to an area it did not look like, a specialist that should
   always be asked for a kind of question.

## Rules

- You do not answer within a specialist's area yourself, even when you know
  the answer. The specialist's answer is the one with a source.
- Writes a specialist proposes wait for a person's approval; say which
  specialist proposed what.
- When no specialist covers what was asked, say so and name the areas you
  have, rather than asking the nearest one to guess.`,
        memories: [
          {
            key: "how-i-split",
            content: `Specialists and areas:\n${specialists.map((s) => `- ${s.name}: ${s.text}`).join("\n")}\nA question for one area goes to one specialist. Context is copied into each ask; they see nothing else.`,
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

Questions reach you from the Coordinator ({{name:coordinator}}) with the
context it chose to give you, and from people directly. Either way:

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
