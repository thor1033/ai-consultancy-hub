# The Teams channel

## What this is

Until this existed the hub had no inbound route. Agents ran when someone opened
`/agents`, called the API, used an MCP client, or when the clock fired
([schedules.md](schedules.md)) — all of them places you go *to*. A colleague is
not somewhere you go. This is the secretary in the channel where the work is
already being discussed: mention it, and it answers there.

It is also, and not incidentally, **the approval surface**. Both of the things
asked for — living in the channel, and writing mail — need the same missing
piece, because a draft has to be approved by a person before it is sent and
there was nowhere for that to happen. The card is that place.

```
Teams channel ──@secretary──▶ POST /api/teams/messages     Bot Framework JWT
                                  │                        (auth.ts)
                                  ▼
                            from.id ──▶ roster ──▶ email ──▶ principals
                                  │                        (identity.ts)
                                  ▼
                        runAgentForPrincipal(… as that person …)
                                  │
      m365_mail_draft ────────────┤   a real draft in Outlook, not sent
                                  ▼
                        approvals row + a card in the thread
                                  │
                           [Approve] ─▶ POST /api/teams/messages
                                         └─▶ Graph /messages/{id}/send
                                             (the WEB APP's credential)
```

## Three things carry the weight

### The token proves Microsoft sent it — not who typed

`/api/teams/messages` is a public URL. Anything that can POST to it can ask the
hub to run an agent, so `lib/teams/auth.ts` verifies the Bot Framework JWT
against Microsoft's published keys: RS256 with the algorithm **pinned** rather
than read from the token, the issuer, an audience that must be *this* bot's app
id, and expiry.

The fourth check is the one that is easy to miss. The reply address
(`serviceUrl`) arrives in the **request body**, and `connector.ts` will send the
bot's credential to whatever address it is handed. So the token's `serviceurl`
claim must match the activity's. Without that, a valid token becomes a way to
point the bot — and its credential — at a host someone else controls.

None of this says who typed the message: the sender is a field in the body, not
a claim in the token. Identity is a separate step.

### A run executes as the person who asked

`lib/teams/identity.ts` resolves `from.id` through the connector's roster call —
not Graph, which would need a tenant-wide permission — to a work address, and
matches it against `principals.email`, the key the hub already uses as its
allowlist.

This is the same rule schedules follow, for the same reason: retrieval is scoped
to the caller's grants ([knowledge-access.md](knowledge-access.md)), so an agent
never has a reach of its own. A channel is a room full of people the hub has
never heard of. Without this step it would be a way to run agents with somebody
else's access.

A Teams user with no principal gets a sentence telling them to sign in once at
the hub — never silence, and never a run.

### Nothing sends from inside the tool loop

The agent's Microsoft 365 credential is `Mail.ReadWrite`: it can write a draft
and cannot send. `Mail.Send` belongs to a **second app registration**
(`M365_SEND_*`) used only by `lib/mail/send.ts`, which is reachable only from a
card press, after `decideApproval` has recorded that a named, enabled person
said yes.

And that credential is **stripped from every MCP server's environment**
(`WITHHELD_FROM_TOOL_SERVERS`), so the process running the model's tools does
not hold it. A send tool smuggled into that server could not authenticate.
`m365_whoami` reports `sendCredentialVisible`, which must always read false.

## What a person sees

Mention the bot and it answers in the thread. If the answer involved writing a
reply, a card follows it:

> **Waiting to be sent**
> Reply to anna@example.com — RE: Can we move Thursday?
> …the draft…
> *This is a draft in Outlook — nothing has been sent. Edit it there first if it
> needs changing; Approve sends whatever the draft says at that moment.*
> **[ Approve and send ] [ Reject ]**

Editing in Outlook and then approving is a supported path, not a workaround:
`send.ts` sends **by draft id**, so the edit is honoured, and it reads the draft
back first so `result` records what actually went out. An approval whose subject
no longer matches what was approved is visible afterwards rather than invisible.

On a decision the card is **replaced**, so the buttons are gone for everyone —
not just for whoever pressed one. A second press is told who decided it and
when.

## Setting it up

Everything below is tenant work; none of it is in this repo.

1. **Azure portal → Create a resource → Azure Bot.** Multi-tenant unless you
   have a reason. Note the **Microsoft App ID**, and create a client secret.
2. **Configuration → Messaging endpoint:** `https://hub.teqneo.co/api/teams/messages`
3. **Channels → Microsoft Teams**, enable it.
4. **Set the secrets** on the hub:

   ```
   TEAMS_APP_ID=<the Microsoft App ID>
   TEAMS_APP_PASSWORD=<the client secret>
   TEAMS_AGENT=secretary            # optional; this is the default
   TEAMS_TENANT_ID=<tenant>         # single-tenant bots only
   ```

   With `TEAMS_APP_ID` unset the endpoint accepts **nothing**. That is
   deliberate: an unconfigured public URL that skips its auth check is worse
   than one that is switched off.

5. **Build the app package** — `apps/web/teams-app/` has the manifest and what
   to put beside it — and upload it to the team.
6. **Check it is live:** `curl https://hub.teqneo.co/api/teams/messages` returns
   `{"endpoint":"teams-messages","configured":true}`. A GET never does work.

For sending, a **separate** app registration with `Mail.Send` (application
permission, admin consent, and the same Application Access Policy as the reading
one — see [secretary-agent.md](secretary-agent.md)), then `M365_SEND_TENANT_ID`,
`M365_SEND_CLIENT_ID`, `M365_SEND_CLIENT_SECRET`.

⚠️ `Mail.Send` as an application permission sends as **any mailbox in the
tenant**. `Test-ApplicationAccessPolicy` must come back `Denied` for a mailbox
that is not the secretary's before this secret exists anywhere.

Until those three are set, Approve records the approval and answers *"Approved,
but not sent: no sending credential is configured… the draft is in Drafts and
can be sent by hand."* Everything else works.

## Two design choices worth knowing

**`Action.Submit`, not `Action.Execute`.** Submit arrives as an ordinary message
activity carrying `value`, which is one code path and one shape to verify.
Execute's universal-action invoke refreshes the card for everyone by itself,
which is nicer, but it is a second protocol to get right without a tenant to try
it against — and the card is replaced on decision anyway.

**The route answers 200 immediately.** Teams expects an answer in seconds and an
agent run takes minutes, so the run continues in the container after the
response goes out (the same shape as `runAgentForPrincipal` and the scheduler).
This is not a shortcut: Teams **retries** an activity it does not get a quick
answer to, and a retried approval would send the mail twice. For the same reason
a handler error still returns 200 — a 500 is an invitation to retry.

## Verify

```bash
node --experimental-transform-types --env-file=.env.local apps/web/verify-teams.mjs
# or: npm run verify:teams -w web
```

Needs `DATABASE_URL`. No Azure Bot, no Microsoft tenant, no API key, no spend.
Fixtures stand in for the Bot Framework's key endpoint, the Bot Connector, the
Messages API and Graph — and a **real RSA keypair signs real JWTs**, so the
token checks are exercised against genuine signatures rather than a stub that
agrees with itself. Everything below the fixtures is the shipping path,
including the real `microsoft365` MCP server as a child process.

46 checks. The ones that matter:

| | |
| --- | --- |
| a token minted for another bot is refused | and `alg: none`, a bad signature, a wrong issuer, an expired token |
| a valid token cannot be replayed at another serviceUrl | the reply-address attack |
| a Teams user the hub does not know gets **no run** | and the model is never called on their behalf |
| a run that drafts parks an approval and posts a card | read from the stored transcript, so a model that forgets to mention a draft cannot lose it |
| Approve sends — with the **sending** registration's token | and nothing using the agent's credential ever reaches a send endpoint |
| a draft edited in Outlook is sent as edited, and flagged | |
| a second Approve sends nothing | Reject sends nothing |
| with no send credential, Approve says so | rather than failing silently |

## What this deliberately does not do

- **No proactive messages.** The bot answers where it was spoken to. A scheduled
  briefing posted into the channel needs a stored conversation reference, which
  is a small increment and not this one.
- **Approvals are decided in Teams, or nowhere.** There is still no page on the
  hub listing what is waiting. Somebody who was not in the channel cannot act on
  one.
- **One kind of gated action.** `mail.send`. Booking a meeting or writing to a
  client's system would each need their own carrying-out path
  ([approvals.md](approvals.md)).
- **No file handling.** `supportsFiles` is false in the manifest; a transcript
  dropped into the channel is not picked up. The `meeting-to-pm` skill still
  runs from Claude Code.
