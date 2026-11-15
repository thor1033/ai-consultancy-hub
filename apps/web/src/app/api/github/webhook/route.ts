import { NextResponse } from "next/server";
import { createProposal, findLiveProposal } from "@ai-hub/db";
import { remoteServerInfo } from "@ai-hub/mcp";
import { loadHubConnections } from "@/lib/connections";
import { pickPmServer, readMergedPr, signatureValid, taskRefs, writesFor } from "@/lib/github/mergedPr";

/*
 * GitHub tells the hub a pull request merged; the hub proposes closing the
 * PM task it names (lib/github/mergedPr.ts, docs/code-handoff.md).
 *
 * Authenticated by the webhook's signature, not a session: GitHub signs every
 * delivery with the shared secret, and a body whose signature does not match
 * is refused before it is parsed. No secret configured means the endpoint is
 * off (503), never open — the same fail-closed rule as every other door.
 *
 * Nothing here writes to the PM tool. It records PROPOSALS, which wait on
 * /approvals for a person, and are executed by the gate's approve() with the
 * hub's credential for the PM server, exactly as an agent's held write is.
 * With no agent and no person behind them, only an admin may decide them.
 *
 * Answers 2xx for every well-formed delivery it chooses to ignore (another
 * event, an unmerged close, a PR naming no task), so GitHub does not retry
 * and mark the hook as failing for doing its job.
 */
export const dynamic = "force-dynamic";

const SECRET_ENV = "HUB_GITHUB_WEBHOOK_SECRET";

export async function POST(req: Request) {
  const secret = process.env[SECRET_ENV]?.trim();
  if (!secret) {
    return NextResponse.json({ error: `GitHub webhooks are off: ${SECRET_ENV} is not set.` }, { status: 503 });
  }

  // The signature covers the raw bytes, so read them before anything parses them.
  const raw = await req.text();
  if (!signatureValid(secret, raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Signature does not match." }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  if (event === "ping") return NextResponse.json({ ok: true, pong: true });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "The body is not JSON." }, { status: 400 });
  }

  const pr = readMergedPr(event, payload);
  if (!pr) return NextResponse.json({ ok: true, ignored: "not a merged pull request" });
  const refs = taskRefs(pr.body);
  if (!refs.length) return NextResponse.json({ ok: true, ignored: "names no PM task" });

  await loadHubConnections();
  const server = pickPmServer(remoteServerInfo(), process.env.HUB_GITHUB_PM_SERVER);
  if ("error" in server) {
    // Said in the response GitHub keeps for the delivery, and in the log: a
    // merge that names a task but proposes nothing must not look like success.
    console.warn(`[github] ${pr.repo}#${pr.number} names ${refs.length} task(s) but nothing was proposed: ${server.error}`);
    return NextResponse.json({ error: server.error }, { status: 422 });
  }

  const proposed: string[] = [];
  const already: string[] = [];
  for (const ref of refs) {
    for (const w of writesFor(pr, ref)) {
      // GitHub redelivers on a timeout or a manual retry; the same merge must
      // not ask twice.
      const existing = await findLiveProposal(server.name, w.tool, w.args);
      if (existing) {
        already.push(existing.id);
        continue;
      }
      const p = await createProposal({
        server: server.name,
        tool: w.tool,
        args: w.args,
        reason: w.reason,
        description: `Proposed by the hub because ${pr.repo}#${pr.number} merged and names this task.`,
      });
      proposed.push(p.id);
    }
  }

  return NextResponse.json({ ok: true, pr: `${pr.repo}#${pr.number}`, tasks: refs, proposed, alreadyHeld: already });
}
