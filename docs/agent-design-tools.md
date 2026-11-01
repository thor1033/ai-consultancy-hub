# Designing agents from Claude Code

The hub's MCP server (`/api/mcp`) offers the agent form as tools, so whoever
builds the hub can design agents and skills from Claude Code, Claude.ai or any
other MCP client by talking to it. For example: "Make a contracts agent that
reads the contracts collection, may ask the Secretary, and has a skill that
reviews a contract for the buyer or the seller."

## The tools

The tools are offered only to a principal with `agent:manage`, which today means
admins. A token that could not save is never shown a tool that would refuse.

| Tool | What it does |
|---|---|
| `hub_list_design_options` | Lists the tool servers this hub has, the models, and what is set on the page instead. Read it first. |
| `hub_agent_get` | Returns one agent whole: brief, model, tools, whom it may ask, knowledge, memory, org chart labels, and its skills with their prompts. |
| `hub_agent_create` | Creates an agent, like **New agent**. The slug is made from the name. |
| `hub_agent_update` | Changes an agent. Only the fields you send change. A list you send (`tools`, `asks`, `knowledgeCollections`) replaces the agent's list. |
| `hub_skill_create` | Gives an agent a skill: a prompt with `{{parameter}}` blanks and the parameters. |
| `hub_skill_update` | Changes a skill. Only the fields you send change. `enabled: false` switches it off without deleting it. |

A long brief or prompt goes through `hub_put_text` first, as for any hub tool,
and the handle is passed in its place.

## The same rules as the form

The agent form and these tools both save through `lib/agentDesign.ts`
(`saveAgentAs`, `saveSkillAs`), as the signed-in person or the token's principal.

- **Tool servers.** A tool server must exist on this hub. One that does not is
  left out, and the answer names it.
- **Model.** An unknown model is refused. An agent's existing model is kept even
  if the list has since changed.
- **Asking.** The agents it may ask must exist, and an agent may not ask itself.
- **Skill prompts.** A prompt may only use parameters it declares. A skill slug
  is unique across the hub.
- **Settings that stay.** An entry that stays on an agent keeps its own settings:
  a mailbox, and writes an admin allowed without approval. The tools cannot set
  either one.
- **Where it runs.** This is admin-only, as on the page.
- **Where an agent came from.** Pattern and import tags are never taken from a
  caller.

## Deliberately not offered

- **Deleting an agent or a skill.** That is a click on its page, by a person
  looking at what they are about to lose.
- **A mailbox per agent, and writes without approval.** Both are set on the
  agent's page; the second is admin-only.
- **Schedules and hand-offs.** These have their own pages.

## After creating

A new agent can be run at once with `hub_run_agent`. Its own `hub_agent_<slug>`
tool, and a new skill's `hub_skill_<slug>`, appear when the client reconnects,
because clients cache tool lists.

## Verifying

`npm run verify:design-tools -w web` (28 checks) drives the real hub MCP server
through a real MCP client. `verify:views` saves through the form's actions to
check that they share the same rules.
