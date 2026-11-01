# A client's own hub

Phase 5 of docs/data-protection-review.md. This guide sets the hub up in a
client's own accounts, so that the client holds its data and Teqneo holds
none.

The position (review, "Recommendation 1"):
- **Teqneo owns the product:** this repository, its patterns, and the MCP
  servers it ships.
- **The client owns everything the product holds:** the database, the keys,
  and the contracts with the model and search providers.
- **Teqneo has no standing access.** When something needs fixing, a client
  admin grants access for some hours, with a reason, and it ends by itself.
- **The hub calls nobody home.** `verify:deployment` checks that the code
  names no outside host a deployment has not chosen.

This is an engineering guide, not a contract. The support agreement and
whether Teqneo is a processor at all are questions for a lawyer (review,
"Questions for a lawyer").

## What the client creates

All of these are in the client's name, in an EU region.

| Account | For | Notes |
|---|---|---|
| **Postgres with pgvector**: Neon, Azure Database for PostgreSQL, AWS RDS | Everything the hub keeps | Set the restore window to match the retention periods below; backups keep deleted data until the window passes |
| **Container hosting**: Fly.io, Azure Container Apps, AWS ECS, anything that runs a Docker image | The hub | One machine, always on: the scheduler runs inside it. 1 GB memory |
| **Claude**: one of the three below | The model | Every question, retrieved passage, tool result and answer goes here |
| **Voyage AI** | Document search (embeddings) | Opt the account out of data use. Without a key, search falls back to a built-in hash and its results are not meaningful |
| **WorkOS**: an environment, with the client's identity provider (Entra ID) connected | Sign-in | WorkOS sees who signs in, not what they do |
| **A secret store**: the host's own (Fly secrets, Key Vault, Secrets Manager) | The settings below | |

### Where Claude runs

`HUB_MODEL_PROVIDER` picks the provider. The hub refuses to call any model
while it is set wrongly: it never falls back to another provider, because
that would send the client's data to a party they did not choose.

| Provider | `HUB_MODEL_PROVIDER` | Needs | Model names |
|---|---|---|---|
| **Claude API** (Anthropic) | `anthropic` (default) | `ANTHROPIC_API_KEY`, from the client's own Console organisation | The hub's own |
| **Amazon Bedrock**, in the client's AWS account | `bedrock` | `AWS_REGION` (required, e.g. `eu-central-1`; without it the AWS SDK would use us-east-1). Credentials come from the host's role, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, or `AWS_BEARER_TOKEN_BEDROCK` | **Required in `HUB_MODEL_IDS`** for every model in use. Bedrock ids carry a region prefix and a version, for example `eu.anthropic.…`; copy them from the Bedrock console |
| **Google Vertex AI**, in the client's Google Cloud project | `vertex` | `CLOUD_ML_REGION` (e.g. `europe-west1`, or `eu`) and `ANTHROPIC_VERTEX_PROJECT_ID`. Credentials are Google's application default credentials (`GOOGLE_APPLICATION_CREDENTIALS`, or the host's service account) | The hub's own, unless `HUB_MODEL_IDS` maps them |

`HUB_MODEL_IDS` is a JSON object mapping the hub's model names to the
provider's, for example `{"claude-opus-4-8": "eu.anthropic.claude-opus-4-8-v1"}`.
The hub keeps its own names everywhere else: stored runs, the agent form,
costs. Costs are computed at Anthropic's list prices; Bedrock and Vertex
price separately, so read their bills for the real figure.

On the Claude API, ask Anthropic about zero data retention for the
organisation before client data flows. On Bedrock and Vertex, the cloud
provider's own data terms apply.

Bedrock runs through AWS's InvokeModel API (`@anthropic-ai/bedrock-sdk`
0.x), which serves the hub's current models. Moving the hub to newer models
is a separate change; it also moves the SDKs to 1.x.

## The settings

Set them in the client's secret store. Never commit them.

| Setting | Value on a client's hub |
|---|---|
| `DATABASE_URL` | The client's Postgres |
| The model settings above | |
| `VOYAGE_API_KEY` | The client's |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | The client's WorkOS environment (docs/auth.md) |
| `HUB_BASE_URL` | The hub's address, e.g. `https://hub.client.example` |
| `ALLOWED_EMAILS` | The client's people. Add Teqneo's support address too: it lets them reach the sign-in page, and lets them in only while a grant is running |
| `HUB_VENDOR_ACCESS` | **Teqneo's domain**, `teqneo.co`. This is the setting that makes Teqneo's access temporary only (below) |
| `HUB_SECRET_KEY` | 32+ random characters, from the client's secret store (`openssl rand -base64 48`). It seals connection tokens; set it before the first connection is added |
| `HUB_SEEDS` | `context-steward`, or `none`. Unset installs every agent Teqneo uses itself, including a Secretary on Teqneo's mailbox |
| `HUB_RETAIN_TRANSCRIPTS_DAYS`, `HUB_RETAIN_ANSWERS_DAYS`, `HUB_RETAIN_AUDIT_DAYS` | What was agreed (docs/retention.md) |
| `HUB_DEFAULT_COLLECTION_VISIBILITY` | Leave unset: documents are private until granted |
| `HUB_SCHEDULER` | `1` on the one machine that runs schedules and the retention sweep |
| `HUB_TIMEZONE` | e.g. `Europe/Copenhagen` |
| `LANGFUSE_*` | Leave unset. If set, only the shape of runs is traced, never content (`HUB_TRACE_CONTENT` stays unset) |
| `M365_*`, `HUB_REMOTE_MCP_SERVERS` | Only for the systems the client connects |

**Check before every deploy:**

```bash
npm run deploy:check -w web     # in the pipeline, with the deployment's own environment
```

The check reads the settings and prints what they amount to: the provider
and its region, whether tracing is on, who receives the data. It never
prints a value, only "set", a host name or a region. It exits 1 when
something must be fixed, such as no sign-in list, no sealing key, a Bedrock
deployment without a region, or a setting that does not parse. An admin
sees the same reading, and the list of who receives the client's data, under
Admin → This deployment, in the Expert view. That list is what a data
processing agreement's annex needs.

## Deploying

The image is this repository's `Dockerfile`. Each release runs one command
before the new version serves (`node packages/db/release.mjs`):
1. Migrate the schema. This is idempotent.
2. Apply the seeds `HUB_SEEDS` names. A misspelt name stops the release
   rather than install nothing.

**On Fly.io, in the client's organisation:**
1. Copy `fly.toml`, changing:
   - `app` to the client's app name;
   - `primary_region` to an EU region.
2. `flyctl secrets set …` the settings above, in the client's organisation.
   Alternatively, the client sets them and Teqneo never sees them.
3. Deploy from **the client's own pipeline**. Copy
   `.github/workflows/deploy.yml` into a repository the client controls
   (a mirror or fork of this one) and change the app name. Its token is
   created by the client, `flyctl tokens create deploy -a <app>`, and kept in
   their repository settings.
   - The token is scoped to one app, but it can do more than ship an image.
     It can open a console on the machine, where the settings are readable.
     So it is access, and it stays with the client.
   - Teqneo publishes releases (tags in this repository); the client's
     pipeline ships the one they choose.

**Elsewhere:**
- Build the image.
- Run `node packages/db/release.mjs` with the app's environment before
  switching traffic.
- Health-check `/api/health`.
- Keep one machine always on.

**The first sign-in.** The first person to sign in to an empty hub becomes
its admin. The vendor never does, even with an allowlisted address. A client
admin should therefore sign in first, before handing the address round.

**Upgrades.** A release is a tag in this repository. The client decides
when to take one, and their pipeline builds and ships it. When the client
wants Teqneo to do the upgrade, that is break-glass work like any other.

## Break-glass access

Teqneo has no standing access to a client's hub. When something needs
fixing, such as an agent, a connection or a failed run:

1. **Teqneo asks the client**, saying what is wrong and what they need to do.
2. **A client admin grants temporary access** under Admin → Temporary
   access. The grant takes:
   - Teqneo's address;
   - a role (admin to fix agents and connections, analyst to use them);
   - a number of hours, at most 72;
   - the reason.
   It is recorded with who granted it.
3. **Teqneo signs in** (browser, or Claude Code through the hub's MCP server)
   and does the work.
4. **It ends**, when the hours are up or when any admin presses "End now".
   It ends everywhere at once:
   - the browser session;
   - Claude Code's sign-in;
   - any credential made with it;
   - any schedule it set up.
5. **The client reads what was done.** The grant stays on the Admin page for
   30 days, with how many conversations, confidential reads and audit entries
   it led to. The audit trail and the read log (docs/sensitivity.md) have the
   detail.

What temporary access cannot do, even as admin:
- change who has access, including giving itself more time, or adding
  someone with standing access;
- relabel what may leave the hub;
- add or re-point a connection, which would be a new place data goes;
- search for, download or erase other people's data.

These stay with the client's own admins.

How it is enforced: one rule, `accessProblem` in `packages/authz/src/access.ts`,
is asked at every door:
- browser sign-in;
- OAuth bearer tokens;
- credentials;
- schedules.

A person the deployment names in `HUB_VENDOR_ACCESS` is let in only through a
grant with an end. They are never auto-provisioned, never made the first
admin, and never given a standing row from the access console. On Teqneo's own
hub `HUB_VENDOR_ACCESS` is unset, because there Teqneo's people are the
client.

**What the client must not hand over:**
- the database password;
- the host's admin login or deploy token;
- the secret store.

Anyone who can change the host's settings can change `HUB_VENDOR_ACCESS`
too, so that power stays with the client.

## Handover checklist

- [ ] The accounts in "What the client creates" exist in the client's name,
      in the EU.
- [ ] `npm run deploy:check -w web` passes with the client's environment.
- [ ] `HUB_VENDOR_ACCESS` names Teqneo, and `HUB_SEEDS` is set.
- [ ] A client admin signed in first.
- [ ] Collections holding HR, health or financial material are restricted and
      labelled (docs/sensitivity.md).
- [ ] The database's restore window matches the retention periods.
- [ ] Anthropic's zero data retention (or the cloud provider's terms) and
      Voyage's data-use opt-out are confirmed on the client's accounts.
- [ ] Teqneo holds no credential to the client's hosting, database or secret
      store. Releases ship from the client's pipeline.
- [ ] Admin → This deployment's list of who receives the data is in the DPA
      annex, or the client's record of processing.

## Verifying

`npm run verify:deployment -w web` runs 59 checks through the shipping code:
- the provider failing closed, and model ids mapped on the wire;
- the Vertex client's request, against a stand-in;
- temporary access:
  - who may grant it, and its limits;
  - that it ends everywhere at once;
  - what it cannot do;
- the vendor never bootstrapped or provisioned;
- the seed selection;
- the deployment check, and that it never prints a secret;
- the code naming no outside host it was not told about.

Not proven: a run against real Bedrock or Vertex, and the OAuth bearer door,
which needs a WorkOS token. That door applies the same `accessProblem` as the
two doors the script does prove.
