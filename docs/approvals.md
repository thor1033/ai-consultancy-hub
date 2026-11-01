# Approvals — the gate on writes

No agent writes unattended until a person has said yes. That is the whole rule,
and it is the same rule for every agent and every server.

```
an agent calls a tool that writes
  └── lib/approvals.ts: held → proposals (pending); the model is told
        └── /approvals, or hub_decide_proposal: a person approves or rejects
              └── approve: the hub executes THE SAME call, args as shown
                    └── executed / failed, with what the tool returned
```

## What is held

A tool call is held when all of these are true:

- the tool is not proven read-only. A tool is a write unless its server says
  `readOnlyHint: true` — "not proven read-only" is the safe reading, the same one
  `proxyTools.ts` uses to drop writes. A server that annotates nothing therefore
  has every tool held until it annotates;
- it is not the agent's own memory (`memory_*`), which never leaves the hub —
  **until the run has read something from outside**: once any tool other than
  memory (or another agent's answer) has returned content in the run, its
  memory writes are held too, with the hub's own reason line. An email or a
  connected system can carry instructions, and what an agent remembers is
  loaded into later runs (docs/data-protection-review.md, F10);
- it is not one of the hub's own `hub_*` tools, each of which decides for itself;
- the agent's entry for that server does not say `"writes": "allow"`.

The bundled servers declare themselves: every `microsoft365` and `teams` tool
carries `readOnlyHint: true`, `teams_notes_save` carries `false`, and the
PM-tool annotates its own. A new bundled server has to do the same or every
one of its tools waits for approval, which is the right default for a server
nobody has looked at yet.

That last switch is the only way round the gate, and it is **per agent, per
server**: on the agent's page, under What it may use, each ticked server has
"Writes need a person's approval", on by default. Only an admin can switch it
off, because it widens what the agent may do unattended. An agent that has it
off for a server writes through that server directly, as before this existed.

The gate stands in every place an agent's tools are executed: a hub run (the
console, `hub_agent_*`, schedules), and the per-agent endpoint a synced Claude
Code sub-agent uses. It does **not** stand between a signed-in person and their
own systems: the PM-tool tools a person reaches through `/api/mcp` with their
own token are theirs, not an agent's.

## What the model sees

The tool result, instead of the upstream's answer:

> HELD FOR APPROVAL. `pm_create_task` (pm-tool) was NOT executed. It is recorded
> as proposal … and a person must approve it on the hub's Approvals page before
> it happens. Carry on as if it has not happened: do not retry it, do not assume
> its effect, and tell the reader exactly what you proposed and that it awaits
> approval.

The tool list differs in one way: every tool whose calls will be held carries
one extra, required argument, **`reason`** — "for the person who approves this:
one or two sentences saying what this changes and the evidence". The gate takes
it off the arguments before the call is recorded, so the upstream never sees it
and a proposal's `args` are exactly what the upstream will receive on approval;
it is stored on the proposal and shown first on `/approvals`, above the
arguments. A call without one is still held, and the page says the agent gave
no reason. An upstream tool that declares its own `reason` argument keeps it,
untouched. The run continues; its output should say what was proposed.

## Who decides

An **admin**, the **person whose reach the run had** — the schedule's owner,
the person in the console, the person whose Claude Code session the sub-agent
ran in — or the **person it was sent to** (below). Never an agent: a credential
bound to an agent is refused, because an agent approving its own writes is no
gate at all.

### Sending one on

A write that is someone else's call — the commercial tasks from a meeting, say —
can be sent to a colleague with a note: from a row, a whole run, or a selection
on `/approvals`, or with `hub_send_proposal` from Claude Code ("send these to
Ditlev"). It is recorded on the proposal (`assigned_to`, `assigned_by`,
`assigned_at`, `assign_note`), and the rules are:

- **Only someone who may decide it may send it.** A decision that is not yours
  is not yours to hand over.
- **Only to a person who could decide it in turn**: an enabled principal with
  an email (a person, not a service credential), not bound to an agent, whose
  role includes `agent:run`. A colleague must have signed in once to be listed.
- **Sending adds a decider; it removes none.** The person who sent it can still
  approve, reject or take it back, so a handoff to someone who is away never
  strands a write. Sending again moves it; it never copies.
- **It counts as waiting on them**, not on the sender: it is under their
  *Waiting on you* and on the red count beside Approvals in their sidebar, and
  under the sender's *Sent on*.

Nobody is mailed or messaged when a write is sent — the count in the sidebar is
the notice, refreshed on every page and every minute. A push (mail, Teams) is the
gap the next section names.

### The page

`/approvals` is built for how writes arrive: in batches, one per run. A
person sees their own runs' writes and the ones sent to them; an admin sees all.

- A headline that says the state ("16 writes waiting for you") over four
  figures: waiting on you, with colleagues, ran and failed in the last 7 days.
- Three tabs: **Waiting on you**, **Sent on**, **Decided** (grouped by day).
- **One card per run**: the agent, when, how many writes, the run's opening
  line, and *Approve all*, *Send all to…*, *Reject all*.
- **One row per write**: the verb and what it touches ("Update task ·
  t_ft87883"), the agent's reason, the changes in words ("Status → In
  progress", "End → Thu, 29 Oct 2026"), and the exact call — tool, server,
  arguments, long fields — one click away. What is shown is presentation
  only (`app/approvals/present.ts`); what runs is the call underneath it.
- **Selection across runs**, with a bar fixed to the bottom of the screen.
  Approving several runs each held call in turn through the same single-item
  path; a failure is recorded on its row and the rest still run.

From Claude Code, `hub_list_proposals` (with who sent what to whom),
`hub_decide_proposal` and `hub_send_proposal` do the same, and `hub_run_status`
names the writes a run left waiting.

## What approving does

The hub executes the very call that was held: the same tool, the same arguments,
on the same server entry, dialled with the hub's own credential for it. Nothing
is re-derived at approval time, because an approver approves what they saw.
Two people approving at once produce one execution (the claim is a conditional
update). The result, or the upstream's refusal, is recorded on the proposal.

A person's forwarded token is never stored with a proposal — it expires in
minutes and must not sit in a table. So an entry that only ever wrote as a
person fails at approval with the upstream's refusal, recorded. The right fix is
the plain one: give the agent the entry whose credential may write, and let this
gate hold it. That is how an agent that was kept read-only "by credential" can
now be given a write-capable entry safely.

## Verifying

```
npm run verify:approvals -w web
```

Needs `DATABASE_URL`; no API key. A real remote MCP server stands in for the
PM-tool. 62 checks, sending on included. It proves which calls are held and which pass, that the held call is
recorded with its exact arguments and not made, that only the right people can
decide, that approving runs the same call with the hub's credential and records
the result, that rejections and double decisions behave, and that the gate
stands at the per-agent endpoint and in the hub's MCP tools.

## Not done yet

- **Expiry.** A pending proposal waits until someone decides. The page shows
  its age; nothing times it out.
- **Notification.** Sending a write to a colleague, or an agent proposing one,
  tells nobody outside the hub: the sidebar count is the only notice. A mail
  or a Teams message needs a write-capable mailbox, which no agent holds yet.
- **Edits.** A proposal is approved or rejected as it stands. Changing an
  argument means rejecting and asking the agent again.
