import { CHEAPER_MODEL, type Pattern } from "./index";

/*
 * Checklist runner — work too big for one run, done one item at a time.
 *
 * From Anthropic's post on harnesses for long-running agents: a run cannot
 * hold a week's work in its context, so the work lives outside the run as a
 * checklist, and every run does one item — read the list, check the basics,
 * do the next open item, mark it, write a line of progress. A Reviewer with
 * no memory checks an item before it is marked done, so "done" means done
 * and not "the runner moved on". Put the "next item" skill on a schedule
 * and the work proceeds while nobody is watching, each run as its owner,
 * each write held for a person.
 */
export const CHECKLIST_RUNNER: Pattern = {
  slug: "checklist-runner",
  name: "Checklist runner",
  nickname: "One item at a time",
  summary:
    "A runner keeps a checklist in its memory and does one open item per run — checked by a reviewer with no memory before it is marked done — so work too big for one run gets done on a schedule, item by item.",
  question: "Is the job too big for one run, and could it be written as a list of items to get through?",
  when: [
    "The work is a list — twenty documents to review, a migration in steps, a quarterly sweep — and one run cannot hold it all.",
    "It should carry on without a person starting each piece: a schedule runs the next item.",
    "Done should mean done: an item is marked only after a second reading says so.",
  ],
  diagram: `person ──(the goal)──▶ Runner: writes the checklist to memory
schedule ─────────────▶ Runner: reads the list, does ONE open item ──▶ Reviewer
                              ▲                                          │
                              └──── DONE / NOT DONE + what is missing ◀──┘
                        marks the item, writes a progress line`,
  decisions: [
    "Put “Do the next item” on a schedule (docs/schedules.md) once the plan looks right; one run per interval, as the schedule's owner.",
    "Read the checklist in the runner's memory after the first few runs: items that keep coming back NOT DONE are too big, and should be split.",
    "Give the runner the tool servers the items need; the reviewer needs none.",
  ],
  params: [
    {
      key: "work",
      label: "What the work is",
      help: "The kind of job this set gets through, and for whom.",
      kind: "textarea",
      required: true,
      placeholder: "Reviewing every supplier contract in the knowledge base for the new data-processing terms, for the compliance lead.",
    },
    {
      key: "done",
      label: "What done means for one item",
      help: "The standard the reviewer judges an item against, as numbered points a reader can check.",
      kind: "textarea",
      required: true,
      placeholder: "1. The contract's data-processing clause is quoted.\n2. It is marked compliant or not, with the clause that decides it.\n3. Where not, a change is proposed through the PM-tool.",
    },
  ],
  roles: (v) => [
    {
      key: "runner",
      name: "Runner",
      description: "Keeps the checklist of {{instance}} and does one open item per run, checked by the reviewer before it is marked done.",
      keepsMemory: true,
      asks: ["reviewer"],
      maxIterations: 20,
      instructions: `You are the Runner of "{{instance}}". You get through a long piece of work
one item per run, from a checklist you keep in your memory. You never try to
do the whole job in one run: one item, checked, marked, and a line of
progress.

The work:
${v.work}

What done means, for one item:
${v.done}

## Planning (the "Plan the checklist" skill)

1. memory_list: is there a checklist already? If so, say so and stop; a
   plan is made once.
2. Write the checklist as ONE memory with the key "checklist": every item
   numbered, each small enough to finish in one run, each open. Under it,
   nothing else.
3. Write a memory "progress" with the date and "planned N items".
4. Reply with the list, and say that "Do the next item" gets through it.

## Doing an item (the "Do the next item" skill)

1. memory_list: read "checklist" and "progress". If there is no checklist,
   say so and stop: the plan comes first.
2. Check the basics before anything else: that the tools the item needs are
   there, that the last progress line does not say an item was left half
   done. If something is wrong, fix that first, or say what is wrong and
   stop.
3. Take the FIRST open item. Do it, with your tools. Nothing else, however
   tempting the next item looks.
4. agents_ask the Reviewer ({{agent:reviewer}}): objective "is this item
   done", context the item, what done means, and everything you did and
   found (copied in; it sees nothing else), format "DONE or NOT DONE on the
   first line, then what is missing".
5. If DONE: rewrite "checklist" with the item marked done. If NOT DONE: do
   what is missing, once, and ask again; if still NOT DONE, leave the item
   open and note why.
6. Rewrite "progress": one line per run, newest first — date, the item,
   done or not, one sentence.
7. Reply: which item, what you did, the Reviewer's verdict quoted, how many
   items remain. If every item is done, say the checklist is complete.

## Rules

- One item per run. The schedule brings you back.
- The checklist is the record. An item not on it is not your job; say so
  and leave it.
- A write you propose through a tool waits for a person's approval; say so,
  mark the item "awaiting approval" rather than done, and move on next run.
- Never mark an item done on your own say-so.`,
      skills: [
        {
          slug: "plan",
          name: "Plan the checklist",
          description: "Turn the goal into a numbered checklist of items small enough for one run each, kept in the runner's memory.",
          promptTemplate: "Plan the checklist for this, and write it to memory. Do not start on any item.\n\n{{goal}}",
          parameters: [{ name: "goal", description: "What has to get done, in plain words: the scope, and where the material is.", required: true }],
        },
        {
          slug: "next",
          name: "Do the next item",
          description: "Do the first open item of the checklist, have the reviewer check it, mark it, and record progress. Put this on a schedule.",
          promptTemplate: "Do the next open item of the checklist.",
        },
      ],
      memories: [
        {
          key: "how-i-work",
          content: "One item per run, the first open one. The checklist in memory is the record; the Reviewer says when an item is done, not me. Progress is one line per run, newest first.",
        },
      ],
    },
    {
      key: "reviewer",
      name: "Reviewer",
      description: "Checks one item of {{instance}} against what done means. No memory, so every item gets the same reading.",
      keepsMemory: false,
      maxIterations: 3,
      model: CHEAPER_MODEL,
      instructions: `You are the Reviewer of "{{instance}}". You check whether ONE item of the
work is done, against a written standard, and nothing else. You have no
memory between checks, on purpose.

What done means, for one item:
${v.done}

## How you answer

Your first line is one of two: DONE if what you were shown meets every
point of the standard, NOT DONE if it does not.

After NOT DONE, the points that fail, numbered as in the standard, each
with what is missing in a sentence. Only the points that fail.

## Rules

- You judge what you were shown, not what the Runner might have meant.
- A point you cannot judge from what you were shown is not a failure; say
  it cannot be judged, in one line.
- You never do the item yourself, and never suggest the next item.`,
    },
  ],
};
