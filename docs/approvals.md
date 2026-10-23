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
- it is not the agent's own memory (`memory_*`), which never leaves the hub, and
  not one of the hub's own `hub_*` tools, each of which decides for itself;
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

The tool list is unchanged: the model may still ask for the write, and learns
from the result that it was held. The run continues; its output should say what
was proposed.

## Who decides

An **admin**, or the **person whose reach the run had** — the schedule's owner,
the person in the console, the person whose Claude Code session the sub-agent
ran in. Never an agent: a credential bound to an agent is refused, because an
agent approving its own writes is no gate at all.

`/approvals` shows a person the proposals from runs that acted as them; an
admin sees all of them. Each shows the tool, the server, the agent, who it acted
as, the exact arguments, what the agent was asked, and after a decision what the
tool returned or why it failed. From Claude Code, `hub_list_proposals` and
`hub_decide_proposal` do the same, and `hub_run_status` names the writes a run
left waiting.

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
PM-tool. It proves which calls are held and which pass, that the held call is
recorded with its exact arguments and not made, that only the right people can
decide, that approving runs the same call with the hub's credential and records
the result, that rejections and double decisions behave, and that the gate
stands at the per-agent endpoint and in the hub's MCP tools.

## Not done yet

- **Expiry.** A pending proposal waits until someone decides. The page shows
  its age; nothing times it out.
- **Batches.** Each call is one proposal. A run that proposes ten tasks makes
  ten rows, decided one by one.
- **Edits.** A proposal is approved or rejected as it stands. Changing an
  argument means rejecting and asking the agent again.
