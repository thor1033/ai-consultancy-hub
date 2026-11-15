import { createHmac, timingSafeEqual } from "node:crypto";
import type { RemoteServerInfo } from "@ai-hub/mcp";

/*
 * A merged pull request, turned into proposed writes on the PM board
 * (docs/code-handoff.md).
 *
 * "Start in T3 Code" on a PM task hands the task to a coding agent with a
 * brief that asks it to put one line in its pull request's description:
 *
 *     PM-Task: <projectId>/<taskId>
 *
 * When GitHub tells the hub that pull request merged, the hub proposes the
 * two writes that close the loop — a note on the task recording what merged,
 * and the task moved to done — and holds both for a person on /approvals,
 * like every other write. A merge is evidence that work landed, not that the
 * task is finished: a person says which.
 *
 * Everything here is pure except the signature check's use of the secret, so
 * verify-github-merge.mjs proves it without a network or a database.
 */

/** The description line that ties a pull request to a PM task. More than one may appear. */
export const PM_TASK_TRAILER = "PM-Task";
/** At most this many tasks per pull request: a PR that claims thirty tasks is a mistake, not a release. */
export const MAX_TASKS_PER_PR = 5;

export interface TaskRef {
  projectId: string;
  taskId: string;
}

/**
 * Whether the body GitHub signed with the shared secret is the body that
 * arrived. Constant-time, and false — never an exception — for a missing or
 * malformed header, so a forged request is simply refused.
 */
export function signatureValid(secret: string, rawBody: string, header: string | null): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The tasks a pull request description names, one `PM-Task: project/task`
 * line each, in order, without duplicates. Ids are kept to the characters the
 * PM tool uses (a uuid project, a short task id), so nothing else from a PR
 * body can ride into a tool call.
 */
export function taskRefs(body: string | null | undefined): TaskRef[] {
  const out: TaskRef[] = [];
  const seen = new Set<string>();
  const line = /^\s*PM-Task:\s*([0-9a-f-]{8,64})\s*\/\s*([A-Za-z0-9_-]{1,64})\s*$/gim;
  for (const m of (body ?? "").matchAll(line)) {
    const key = `${m[1].toLowerCase()}/${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ projectId: m[1].toLowerCase(), taskId: m[2] });
    if (out.length === MAX_TASKS_PER_PR) break;
  }
  return out;
}

/**
 * Which registered server the PM writes go through: `HUB_GITHUB_PM_SERVER`
 * when set, else the one PM-tool entry that may write. Null — and so no
 * proposals, with the reason logged — when that is ambiguous or absent: a
 * proposal for a server that cannot run it would only fail at approval.
 */
export function pickPmServer(
  servers: (Pick<RemoteServerInfo, "name" | "readOnly"> & { configured?: boolean })[],
  configured?: string | null,
): { name: string } | { error: string } {
  if (configured?.trim()) {
    const want = configured.trim();
    const hit = servers.find((s) => s.name === want);
    if (!hit) return { error: `HUB_GITHUB_PM_SERVER names "${want}", which is not a registered server.` };
    if (hit.readOnly) return { error: `HUB_GITHUB_PM_SERVER names "${want}", which is read-only and could not run the writes.` };
    return { name: hit.name };
  }
  // A server whose credential is missing could not run the writes either.
  const writable = servers.filter((s) => /^pm[-_]?tool/i.test(s.name) && !s.readOnly && s.configured !== false);
  if (writable.length === 1) return { name: writable[0].name };
  return {
    error: writable.length
      ? `Several PM-tool servers may write (${writable.map((s) => s.name).join(", ")}); set HUB_GITHUB_PM_SERVER to choose one.`
      : "No PM-tool server that may write is registered; set HUB_GITHUB_PM_SERVER.",
  };
}

/** The parts of GitHub's pull_request payload this reads. Anything else is ignored. */
export interface MergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedBy: string | null;
  mergedAt: string | null;
  body: string | null;
}

/** A merged pull request from a `pull_request` event, or null for any other event or action. */
export function readMergedPr(event: string | null, payload: unknown): MergedPr | null {
  if (event !== "pull_request") return null;
  const p = payload as {
    action?: string;
    pull_request?: { merged?: boolean; number?: number; title?: string; html_url?: string; body?: string | null; merged_at?: string | null; merged_by?: { login?: string } | null };
    repository?: { full_name?: string };
  };
  const pr = p?.pull_request;
  if (p?.action !== "closed" || !pr?.merged || typeof pr.number !== "number" || !pr.html_url) return null;
  return {
    repo: p.repository?.full_name ?? "",
    number: pr.number,
    title: (pr.title ?? "").slice(0, 200),
    url: pr.html_url,
    mergedBy: pr.merged_by?.login ?? null,
    mergedAt: pr.merged_at ?? null,
    body: pr.body ?? null,
  };
}

export interface ProposedWrite {
  tool: "pm_add_note" | "pm_update_task";
  args: Record<string, unknown>;
  reason: string;
}

/**
 * The two writes a merge proposes for one task. Deterministic — no dates, no
 * clock — so GitHub redelivering the same event proposes the same calls and
 * the caller can recognise them as already held.
 */
export function writesFor(pr: MergedPr, ref: TaskRef): ProposedWrite[] {
  const who = pr.mergedBy ? ` by ${pr.mergedBy}` : "";
  const where = `${pr.repo}#${pr.number}`;
  return [
    {
      tool: "pm_add_note",
      args: {
        projectId: ref.projectId,
        taskId: ref.taskId,
        title: `Merged: ${pr.title || where}`,
        body: `Pull request ${where} merged${who}.\n${pr.url}`,
      },
      reason: `Pull request ${where} ("${pr.title}") merged${who} and names this task in its description. Records the merge on the task.`,
    },
    {
      tool: "pm_update_task",
      args: { projectId: ref.projectId, taskId: ref.taskId, status: "done" },
      reason: `Pull request ${where} merged${who}. Marks the task done — approve if the merge finished it; reject if work remains (${pr.url}).`,
    },
  ];
}
