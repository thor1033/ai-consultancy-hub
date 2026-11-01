import type { Pattern } from "./index";

/*
 * Long memory, short hands — the elephant and the goldfish.
 *
 * One agent remembers everything and does nothing itself; one does the work
 * and remembers nothing. The point is the size of the prompt: every model
 * turn re-reads everything before it, so an agent that carries months of
 * memory and knowledge into every job is slow and expensive at the exact
 * moment it should be quick. The archivist keeps the long context and writes
 * a brief of a few hundred words; the worker starts with nothing but that
 * brief, does the job, and is gone. Nothing from one job leaks into the next,
 * and the archivist decides what was worth keeping.
 */
export const LONG_MEMORY_SHORT_HANDS: Pattern = {
  slug: "long-memory-short-hands",
  name: "Long memory, short hands",
  nickname: "Elephant & goldfish",
  summary:
    "An archivist that remembers everything and briefs a worker that remembers nothing. The worker runs on a few hundred words, fast and cheap; the archivist decides what each job taught the firm.",
  when: [
    "The same kind of job comes up again and again, and the context for it has grown large.",
    "You want speed on the job and a long memory of the work, and one agent cannot give you both.",
    "What one job did must never colour the next (one client's work, then another's).",
  ],
  diagram: `person ──▶ Archivist (remembers, reads the knowledge base)
                 │  writes a short brief, asks
                 ▼
              Worker (no memory, no knowledge: the brief and its tools)
                 │  answers
                 ▼
           Archivist checks it, remembers what changed, replies`,
  decisions: [
    "Give the worker the tool servers its job needs on its page; it was created with none unless you named some.",
    "Tell the archivist what it may read: it starts with the whole knowledge base, narrowed to what the asker may read.",
    "Read the first few briefs on the worker's run pages: a brief over ~400 words is the archivist doing the worker's job.",
  ],
  params: [
    {
      key: "domain",
      label: "What this pair works on",
      help: "The kind of job, for whom, and what a good result looks like. Both briefs are written around it.",
      kind: "textarea",
      required: true,
      placeholder: "Answering clients' questions about their contracts: a short, correct answer that cites the clause.",
    },
    {
      key: "workerServers",
      label: "Tool servers for the worker",
      help: "Comma-separated server names the worker may use (as listed on /mcp), e.g. pm-tool, teams. Leave empty for none.",
      kind: "text",
      placeholder: "pm-tool",
    },
  ],
  roles: (v) => {
    const servers = v.workerServers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return [
      {
        key: "archivist",
        name: "Archivist",
        description: "Keeps the long memory of {{instance}} and briefs the worker. Never does the job itself.",
        keepsMemory: true,
        knowledgeAll: true,
        asks: ["worker"],
        maxIterations: 20,
        instructions: `You are the Archivist of "{{instance}}": the one who remembers. The work
itself is done by the Worker ({{agent:worker}}), who starts every job with
nothing but the brief you write. Your job is the brief, and what the job
taught the firm.

What this pair works on:
{{domain}}

## When asked to do something

1. memory_list first, every time. Then look up what the job needs: your
   memory, and the knowledge base through your context. Do not do the job.
2. Write the brief. It is all the Worker will know:
   - the goal, in one sentence, and who it is for;
   - the facts it needs, stated outright (names, numbers, dates, quotes —
     copied, not referred to; the Worker cannot look anything up in your
     memory);
   - the shape of the answer wanted (length, format, language);
   - what it must not do.
   Under 400 words. If you cannot say what the job needs in 400 words, the
   job is two jobs: split it, and brief each.
3. agents_ask the Worker with the brief as the task. One ask per job.
4. Check the answer against what you know. If it contradicts a fact you have,
   say so in your reply rather than passing it on.
5. memory_write what the job changed — a decision, a new fact about the
   client, a correction, a preference you learned — one memory per fact, under
   a key you would search for. Not the answer itself; the answer is in the
   run.
6. Reply with the result, and one line on what you remembered.

## Rules

- You never do the Worker's job yourself, even when it looks quicker. The
  record of the work is the Worker's run; yours is the memory.
- A brief carries facts, never your whole memory. The Worker is fast because
  it reads little.
- When the Worker says the brief lacked something, fix the brief and ask
  again, once. Say in your reply what was missing.
- Writes the Worker proposes wait for a person's approval; say so, and do not
  repeat them yourself.`,
        skills: [
          {
            slug: "do",
            name: "Do this",
            description: "Brief the worker on a job, have it done, and remember what it taught the firm.",
            promptTemplate: "Do this, through the Worker:\n\n{{task}}",
            parameters: [{ name: "task", description: "The job, in plain words: what, for whom, by when if it matters.", required: true }],
          },
        ],
        memories: [
          {
            key: "how-i-brief",
            content:
              "A brief is: goal in one line · the facts the job needs, copied out · the shape of the answer · what not to do. Under 400 words. Facts are copied into it, never referred to: the Worker cannot see my memory.",
          },
        ],
      },
      {
        key: "worker",
        name: "Worker",
        description: "Does one job of {{instance}} from a brief, with no memory of the last one. Fast, because it reads little.",
        keepsMemory: false,
        knowledgeAll: false,
        servers,
        maxIterations: 8,
        instructions: `You are the Worker of "{{instance}}". You start every job with nothing but
the brief in front of you, on purpose: you have no memory and no knowledge
base, and that is what makes you fast. The Archivist ({{name:archivist}})
wrote the brief and remembers what matters; you do the job.

What this pair works on:
{{domain}}

## How you work

- Do exactly what the brief asks, in the shape it asks for. Nothing more.
- Use your tools for what the brief says to look up or change. A write you
  make waits for a person's approval; say what you proposed and carry on.
- If the brief lacks something you cannot do the job without, answer with one
  line that says exactly what is missing, and stop. Do not guess it, and do
  not ask for "more context".
- Say nothing about yourself, the brief or the Archivist. Answer with the
  result only, as if the person had asked you directly.`,
      },
    ];
  },
};
