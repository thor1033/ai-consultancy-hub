import type { Pattern } from "./index";

/*
 * Stages, one after another — the assembly line.
 *
 * Each stage is an agent that receives what the stage before it produced,
 * does its one transformation, and answers; the hub hands its answer to the
 * next stage when it finishes. No stage asks another anything, so each is as
 * small as its own job, and a person can read every stage's output on its
 * run page. The Secretary handing a processed meeting to the Context Steward
 * is this shape, built by hand before patterns existed.
 */
export const PIPELINE: Pattern = {
  slug: "pipeline",
  name: "Stages, one after another",
  nickname: "Assembly line",
  summary:
    "A chain of agents, each doing one transformation on what the stage before it produced. Started by running the first stage's skill; the hub hands each finished stage to the next.",
  when: [
    "The work has clear steps that different briefs do best (extract → check → write up).",
    "You want to read each step's output on its own, and change one step without touching the others.",
    "Nothing needs to go back a step; if it does, that step is the writer-reviewer pattern instead.",
  ],
  diagram: `person ──▶ Stage 1 ──(hand-off: its answer)──▶ Stage 2 ──▶ Stage 3
            each stage: no memory, one job, its own tools
            every stage's output is a run page a person can read`,
  decisions: [
    "Run the first stage's skill with a real input and read every stage's run before trusting the chain.",
    "Give a stage that needs a tool server the server on its page; stages were created with none.",
    "Hand-offs fire up to two stages deep from a person's run; a longer line needs a person or a schedule to restart it.",
  ],
  params: [
    {
      key: "input",
      label: "What goes in",
      help: "What the first stage receives, in a few words.",
      kind: "text",
      required: true,
      placeholder: "A client's email asking for a change to their project",
    },
    {
      key: "stages",
      label: "Stages",
      help: "One per line, in order, written “Name: what this stage does to what it receives”. Two or three stages is right; more than four is a sign the work is not a line.",
      kind: "list",
      required: true,
      placeholder: "Extract: list every request in the email as a numbered line with the quote it came from\nCheck: for each request, say whether the board already has it and what it would cost\nReply: draft the reply to the client, one paragraph per request, in their language",
    },
  ],
  roles: (v, lists) => {
    const stages = lists.stages;
    return stages.map((s, i) => {
      const first = i === 0;
      const last = i === stages.length - 1;
      const next = stages[i + 1];
      return {
        key: s.key,
        name: `${i + 1}. ${s.name}`,
        description: `Stage ${i + 1} of ${stages.length} of {{instance}}: ${s.text}.`,
        keepsMemory: false,
        maxIterations: 10,
        instructions: `You are stage ${i + 1} of ${stages.length} in "{{instance}}": ${s.name}.
${first ? `What comes in: ${v.input}.` : `You receive the answer of stage ${i} (${stages[i - 1].name}) in your prompt.`}
Your job: ${s.text}

${last ? "You are the last stage: your answer is what the person reads." : `When you finish, the hub hands your answer to stage ${i + 2} (${next.name}), which gets your answer and nothing else. So your answer must carry everything the next stage needs, in full — every item, every quote, every number — in a shape it can work from. Do not summarise what you were given away.`}

Rules:
- Do your stage only. Do not do the next stage's work, and do not redo the
  previous stage's.
- You have no memory between runs, on purpose. Everything you know is in the
  prompt and your tools.
- When what you received is not enough for your stage, say exactly what is
  missing at the top of your answer, then do what you can.
- A write you propose through a tool waits for a person's approval; say so.`,
        ...(first
          ? {
              skills: [
                {
                  slug: "start",
                  name: `Start ${v.instance}`,
                  description: `Put something through the ${v.instance} line: ${stages.map((x) => x.name).join(" → ")}.`,
                  promptTemplate: `Stage 1 of "{{instance}}". Here is what came in:\n\n{{input}}`,
                  parameters: [{ name: "input", description: v.input, required: true }],
                },
              ],
            }
          : {}),
      };
    });
  },
  handoffs: (v, lists) => {
    const stages = lists.stages;
    return stages.slice(0, -1).map((s, i) => ({
      from: s.key,
      ...(i === 0 ? { skill: "start" } : {}),
      to: stages[i + 1].key,
      prompt: `Hand-off from stage ${i + 1} of "{{instance}}" ({{agentName}}). Its answer, in full:\n\n{{output}}\n\nDo stage ${i + 2} on this.`,
      note: `it does stage ${i + 2}, ${stages[i + 1].name}: ${stages[i + 1].text}`,
    }));
  },
};
