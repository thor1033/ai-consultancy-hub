import { CHEAPER_MODEL, type Pattern } from "./index";

/*
 * Second opinion — the same question to several minds at once.
 *
 * The one parallelisation the hub could use (docs/effective-agents-review.md,
 * H2, after C2): an asker puts the same question to two or three readers in
 * ONE turn, so they run at once and the asker waits for the slowest, not
 * the sum; then it reports where they agree, where they differ, and which
 * reading it would follow and why. Not a cluster: the readers are not
 * specialists in different areas but different stances on the same question
 * — the cautious one, the commercial one, the one who reads it as the
 * client would. It costs as many runs as there are readers; use it for the
 * decisions that are worth a second opinion, not for every question.
 */
export const SECOND_OPINION: Pattern = {
  slug: "second-opinion",
  name: "Second opinion",
  nickname: "Three readings",
  summary:
    "An asker puts the same question to two or three readers at once — each with a different stance — and reports where they agree, where they differ, and which reading it would follow.",
  question: "Is this a decision worth a second opinion, where different stances on the same question would see different things?",
  when: [
    "The answer depends on judgement — a risk, a price, a wording — and one reading is likely to miss what another sees.",
    "You want the disagreement shown, not smoothed over.",
    "The question is worth two or three runs; most questions are not.",
  ],
  diagram: `person ──▶ Asker ──(same question, one turn)──▶ Cautious reader
                  │                                  Commercial reader   (at once)
                  │                                  Client's reader
                  ◀────────────── three readings ────────────────┘
          where they agree · where they differ · which to follow, and why`,
  decisions: [
    "Keep the readers to two or three: each is a run, and a fourth rarely sees anything new.",
    "Read the first run pages: readers who always agree are the same stance twice; rewrite one.",
    "Give the readers the knowledge the question needs; the asker needs only the readers.",
  ],
  params: [
    {
      key: "job",
      label: "What the second opinion is for",
      help: "The kind of question that gets more than one reading, and for whom.",
      kind: "textarea",
      required: true,
      placeholder: "Whether to accept a client's proposed contract change, for the partners.",
    },
    {
      key: "readers",
      label: "Readers",
      help: "Two or three, one per line, written “Name: the stance they read from”. Each becomes an agent.",
      kind: "list",
      required: true,
      placeholder: "Cautious: what could go wrong, what we would be bound to, worst case first\nCommercial: what it is worth, what it costs us to refuse, the relationship\nClient's eyes: how the client reads it, what they are really asking for",
    },
  ],
  roles: (v, lists) => {
    const readers = lists.readers;
    const roster = readers.map((r) => `- ${r.name} ({{agent:${r.key}}}): ${r.text}`).join("\n");
    return [
      {
        key: "asker",
        name: "Asker",
        description: "Puts a question of {{instance}} to every reader at once and reports where they agree, where they differ, and which to follow.",
        keepsMemory: true,
        asks: readers.map((r) => r.key),
        maxIterations: 10,
        instructions: `You are the Asker of "{{instance}}". You get a question more than one
reading, by asking every reader the same question at once and putting the
readings side by side — never by answering it yourself first.

What this set is for:
${v.job}

The readers, and the stance each reads from:
${roster}

## How you work

1. memory_list: what earlier questions taught you about these readers.
2. Write the question ONCE: objective (the question as asked, and what the
   decision is), context (every fact the asker gave, copied in — the
   readers see nothing else), format ("your reading in under 300 words:
   what you see, what you would do, and the one thing the others may
   miss"). The same four fields to every reader; the stance is theirs.
3. agents_ask EVERY reader in the SAME turn, one call each. They run at
   once; asking them one after another wastes the person's time.
4. Report, in this order:
   - Where they agree, in a sentence.
   - Where they differ: each point of difference with who said what, in
     their words where it matters.
   - Which reading you would follow on each difference, and why, in a
     sentence each. Say when you cannot choose.
   - What none of them could say: the gap.
5. memory_write what the question taught you: a reader that keeps seeing
   what the others miss, a kind of question one reading is enough for.

## Rules

- Every reader gets the same question. A reader told less than another is
  not a second opinion.
- You do not smooth a disagreement over; the person is reading for it.
- A reader still working after the wait is reported as missing, not
  guessed at.`,
        memories: [
          {
            key: "how-i-ask",
            content: "One question, written once, sent to every reader in the same turn so they run at once. The report shows the seams: agreement, differences with names, which I would follow and why, the gap.",
          },
        ],
      },
      ...readers.map((r) => ({
        key: r.key,
        name: r.name,
        description: `Reads a question of {{instance}} from one stance: ${r.text}.`,
        keepsMemory: false,
        maxIterations: 8,
        model: CHEAPER_MODEL,
        instructions: `You are ${r.name}, a reader of "{{instance}}" ({{name:asker}} asks you).
You read every question from one stance, on purpose, so that the Asker can
set your reading beside the others':

${r.text}

## How you answer

Under 300 words: what you see from your stance, what you would do, and the
one thing readers of other stances may miss. From the facts you were sent
and your tools; where a fact you need is missing, say which, and do not
guess it. You answer the Asker, not the person; the Asker puts the readings
together.

## Rules

- Your stance is a way of reading, not a conclusion: if your stance finds
  nothing to object to, say so plainly.
- You never soften your reading to match what another reader might say;
  the difference is the point.`,
      })),
    ];
  },
};
