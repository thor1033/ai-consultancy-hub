import type { KnowledgeAccess } from "@ai-hub/authz";
import { collectionSensitivities, collectionsKeptInside, highestSensitivity, serverSensitivities, type Sensitivity } from "@ai-hub/db";

/*
 * What a sensitivity label does (docs/sensitivity.md). Labels are set once, on
 * a collection or a connection, by an admin; runs inherit the highest label
 * they touched. Storage is in @ai-hub/db (sensitivity.ts); the rules are here,
 * beside the runs they govern.
 *
 *                       internal   confidential              special
 *   memory              by scope   never wider than its       never
 *                                  collection
 *   transcript          7 days     7 days                     not kept
 *   trace               shape      shape                      none at all
 *   leaves the hub      yes        no                         no
 *   (hub MCP server, local agents, an agent's answer over MCP)
 *
 * "Leaves the hub" is the egress rule (data-protection-review 2.5, F8): what
 * the hub's MCP server returns goes into whatever Claude account the person
 * connected, possibly a personal one, on that account's terms. Material an
 * admin labelled confidential stays in the hub, where retention and the read
 * log apply; the person reads it there.
 */

export interface RunLabel {
  label: Sensitivity;
  /** What raised it, in words: `"hr-cases" (special)`. Empty when internal. */
  sources: string[];
}

/** The highest label among what a run retrieved and the connections it has. */
export async function labelRun(input: {
  retrieved: (string | null)[];
  servers: string[];
  /** A label inherited from the run that started this one. */
  floor?: Sensitivity;
}): Promise<RunLabel> {
  const [collections, servers] = await Promise.all([collectionSensitivities(), serverSensitivities()]);
  const sources: string[] = [];
  const labels: Sensitivity[] = [input.floor ?? "internal"];
  if (input.floor && input.floor !== "internal") sources.push(`the run that started it (${input.floor})`);
  for (const c of new Set(input.retrieved)) {
    const l = c ? collections.get(c) : undefined;
    if (l) {
      labels.push(l);
      sources.push(`"${c}" (${l})`);
    }
  }
  for (const s of new Set(input.servers)) {
    const l = servers.get(s);
    if (l) {
      labels.push(l);
      sources.push(`the ${s} connection (${l})`);
    }
  }
  const label = highestSensitivity(labels);
  return { label, sources: label === "internal" ? [] : sources };
}

/** What the model is told on a run that touched special material. */
export function specialNote(sources: string[]): string {
  return [
    `This conversation draws on special-category material (${sources.join(", ")}): health, union membership or similar.`,
    "You have no memory in it, and nothing from it is kept beyond the answer. Do not offer to remember anything, and do not repeat more of the material than the task needs.",
  ].join(" ");
}

/** Whether material under this label may be returned to a client outside the hub. */
export const mayLeave = (label: Sensitivity): boolean => label === "internal";

/**
 * The answer an outside client gets instead of one that may not leave: where
 * to read it. The run itself is unchanged; the person reads it in the hub.
 */
export function withheldAnswer(label: Sensitivity, runId: string, baseUrl?: string): string {
  const where = baseUrl ? `${baseUrl.replace(/\/$/, "")}/runs/${runId}` : `the hub, run ${runId}`;
  return (
    `The answer is ready, but it draws on ${label} material, which stays inside the hub. ` +
    `Read it at ${where} — it is also under "Your answers" on the agent's page. ` +
    "Tell the person so; do not guess at what it says."
  );
}

/** A reader's access with these collections taken out. Never widens. */
export function withoutCollections(access: KnowledgeAccess, kept: string[]): KnowledgeAccess {
  if (!kept.length) return access;
  if (access.kind === "all") return { kind: "deny", collections: [...kept] };
  if (access.kind === "allow") return { ...access, collections: access.collections.filter((c) => !kept.includes(c)) };
  return { kind: "deny", collections: [...new Set([...access.collections, ...kept])] };
}

/** The same access, as it applies to a client outside the hub: nothing labelled. */
export async function outsideAccess(access: KnowledgeAccess): Promise<{ access: KnowledgeAccess; kept: string[] }> {
  const kept = await collectionsKeptInside();
  return { access: withoutCollections(access, kept), kept };
}

/** The connections an outside client may not be handed: any labelled above internal. */
export async function connectionsKeptInside(): Promise<Set<string>> {
  return new Set((await serverSensitivities()).keys());
}

export { SENSITIVITY_WORDS } from "@/lib/sensitivityWords";
