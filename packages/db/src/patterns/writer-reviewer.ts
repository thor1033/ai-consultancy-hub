import type { Pattern } from "./index";

/*
 * Writer and reviewer — the critic loop.
 *
 * One agent writes, another judges the draft against a written standard and
 * says only what fails; the writer revises and asks again, a bounded number
 * of times, then delivers with the verdict attached. The reviewer never
 * rewrites, so its judgement stays independent of its taste; the writer never
 * skips a point silently, so what reaches the person is either approved or
 * honest about what is not.
 */
export const WRITER_REVIEWER: Pattern = {
  slug: "writer-reviewer",
  name: "Writer and reviewer",
  nickname: "Critic loop",
  summary:
    "A writer drafts, a reviewer judges the draft against a written standard and names what fails, the writer revises — up to three rounds — and delivers with the verdict attached.",
  when: [
    "The output has a standard you can write down (a checklist, a house style, a client's format).",
    "A second reading catches what the first writer cannot see in their own draft.",
    "You would rather have an honest “not yet” than a confident draft with a hole in it.",
  ],
  diagram: `person ──▶ Writer ──(draft + standard)──▶ Reviewer
              ▲                                   │
              └────── APPROVED / NOT YET + points ─┘   (up to 3 rounds)
              ▼
         delivered, with the reviewer's last verdict quoted`,
  decisions: [
    "Keep the standard short and testable: a point the reviewer cannot judge from the draft alone is noise.",
    "Read the first few run pages: three rounds every time means the standard and the writer's brief disagree.",
    "Give the writer the tool servers it needs to draft from facts; the reviewer needs none.",
  ],
  params: [
    {
      key: "work",
      label: "What is written",
      help: "The kind of piece, and for whom.",
      kind: "text",
      required: true,
      placeholder: "Proposals to prospective clients, in Danish",
    },
    {
      key: "standard",
      label: "What good looks like",
      help: "The standard the reviewer judges against, as numbered points. Each should be something a reader can check from the draft.",
      kind: "textarea",
      required: true,
      placeholder: "1. Opens with the client's problem in their words, not ours.\n2. Names a price or a range.\n3. No sentence starts with “AI”.\n4. Under 600 words.",
    },
  ],
  roles: (v) => [
    {
      key: "writer",
      name: "Writer",
      description: "Drafts {{work}} and has each draft reviewed against the standard before delivering it.",
      keepsMemory: true,
      asks: ["reviewer"],
      maxIterations: 15,
      instructions: `You are the Writer of "{{instance}}". You write: ${v.work}.
Nothing you write reaches a person before the Reviewer ({{agent:reviewer}})
has judged it against the standard.

The standard:
${v.standard}

## How you work

1. memory_list: what earlier reviews taught you.
2. Draft the piece, from the facts you were given and your tools.
3. agents_ask the Reviewer with the whole draft and the standard, both in
   full. Ask for a verdict.
4. If the first line of the verdict is APPROVED, deliver.
   If it is NOT YET: revise exactly the numbered points it names — not the
   rest — and ask again. At most three rounds in all.
5. Deliver the piece, then a line: the Reviewer's last verdict, quoted. If it
   is still NOT YET after three rounds, the points that remain, unchanged,
   so the person sees them. Never drop a point silently.
6. memory_write what the review taught you about this kind of piece, one
   memory per lesson, so the next draft needs fewer rounds.

## Rules

- You do not judge your own draft against the standard; the Reviewer does.
- You do not argue with a point; you fix it, or you leave it visible.
- A write you propose through a tool waits for a person's approval; say so.`,
    },
    {
      key: "reviewer",
      name: "Reviewer",
      description: "Judges a draft of {{work}} against the standard and names what fails. Never rewrites.",
      keepsMemory: false,
      maxIterations: 3,
      instructions: `You are the Reviewer of "{{instance}}". You judge drafts of
${v.work} against a standard, and nothing else. You have no memory between
reviews, on purpose: every draft gets the same reading.

The standard:
${v.standard}

## How you answer

Your first line is one word: APPROVED if the draft meets every point of the
standard, NOT YET if it does not.

After NOT YET, the points that fail, numbered as in the standard, each with:
what in the draft fails it (quote it), and what would meet it, in a sentence.
Only the points that fail; say nothing about the ones that pass.

## Rules

- You never rewrite the draft, suggest a better phrasing of your own, or
  judge anything the standard does not name. Your taste is not the standard.
- A point you cannot judge from the draft alone is not a failure; say it
  cannot be judged, in one line, and move on.
- If the standard was not included, answer NOT YET and ask for it.`,
    },
  ],
};
