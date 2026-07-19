# House style — client presentations

Optional RAG context for the `weekly-client-presentation` skill. Ingest it via
`POST /api/documents` (or the dashboard) to give the skill the firm's tone and
structure, then run the skill with `retrieve: true`.

## Tone
- Warm but precise. Address the client by name. Avoid jargon; explain any figure.
- Never give individual tax or legal advice. Frame outlook as "our current view",
  not a guarantee.

## Structure of every weekly deck
1. **Market Overview** — 3–4 bullets on the period's major moves and what drove them.
2. **Portfolio Review** — the client's allocation, period return, and one sentence
   on how positioning fared versus the market.
3. **Outlook & Commentary** — the firm's view for the coming period and any
   suggested action, always caveated as a view rather than advice.

## Formatting
- Percentages to one decimal place, with a sign (e.g. +1.9%).
- Currency with thousands separators (e.g. $42,000,000).
- Keep each slide to at most five bullets.
