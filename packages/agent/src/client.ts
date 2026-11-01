import Anthropic from "@anthropic-ai/sdk";
import type { ModelId } from "./models";

/*
 * Where the model runs, chosen per deployment (docs/client-deployment.md).
 *
 *   HUB_MODEL_PROVIDER   anthropic (default) | bedrock | vertex
 *
 * The provider is who receives every prompt, document passage, tool result
 * and answer, so it is the deployment's decision to write down, never the
 * code's to guess:
 *
 *   anthropic  the Claude API, with ANTHROPIC_API_KEY — the client's own key
 *              in a client-owned deployment, so they hold the contract and
 *              its retention terms (data-protection-review F6)
 *   bedrock    Claude on the client's own AWS account. AWS_REGION is
 *              required: the SDK would otherwise quietly fall back to
 *              us-east-1, out of the EU. Credentials come from the AWS chain
 *              (role, env, profile) or AWS_BEARER_TOKEN_BEDROCK
 *   vertex     Claude on the client's own Google Cloud project.
 *              CLOUD_ML_REGION and ANTHROPIC_VERTEX_PROJECT_ID are required;
 *              credentials are Google's application default credentials
 *
 * Fails closed: a value that is not one of these is an error on every run,
 * never a fall back to the Claude API — that would send a client's data to a
 * party their deployment did not name.
 *
 * Model ids differ by platform. The hub keeps its own ids everywhere (stored
 * runs, costs, the agent form); HUB_MODEL_IDS maps them to the platform's,
 * as JSON: {"claude-opus-4-8": "eu.anthropic.claude-opus-4-8-v1"}. On Vertex
 * the hub's id is used unchanged unless mapped. On Bedrock every model in use
 * must be mapped — its ids carry a region prefix and a version suffix that
 * depend on the account's access, so a guessed id would only fail later and
 * less clearly.
 */

export const MODEL_PROVIDERS = ["anthropic", "bedrock", "vertex"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The provider this deployment names, or the reason it names none that works. */
export function modelProvider(env: NodeJS.ProcessEnv = process.env): { provider: ModelProvider } | { error: string } {
  const raw = (env.HUB_MODEL_PROVIDER ?? "").trim().toLowerCase();
  if (!raw) return { provider: "anthropic" };
  if ((MODEL_PROVIDERS as readonly string[]).includes(raw)) return { provider: raw as ModelProvider };
  return { error: `HUB_MODEL_PROVIDER is "${env.HUB_MODEL_PROVIDER}", which is not one of ${MODEL_PROVIDERS.join(", ")}. No model is called until it is fixed.` };
}

/** HUB_MODEL_IDS, read. Malformed ⇒ an error, not an empty map. */
export function modelIdMap(env: NodeJS.ProcessEnv = process.env): { map: Record<string, string> } | { error: string } {
  const raw = env.HUB_MODEL_IDS?.trim();
  if (!raw) return { map: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string" || !v.trim()) throw new Error(`"${k}" does not map to a model id`);
      map[k] = v.trim();
    }
    return { map };
  } catch (err) {
    return { error: `HUB_MODEL_IDS is not a JSON object of model ids (${err instanceof Error ? err.message : String(err)}).` };
  }
}

/** The id this deployment's provider knows the hub's model by. Throws, in words, when it cannot say. */
export function providerModelId(model: ModelId | string, env: NodeJS.ProcessEnv = process.env): string {
  const p = modelProvider(env);
  if ("error" in p) throw new Error(p.error);
  const ids = modelIdMap(env);
  if ("error" in ids) throw new Error(ids.error);
  const mapped = ids.map[model];
  if (mapped) return mapped;
  if (p.provider === "bedrock") {
    throw new Error(
      `"${model}" has no Bedrock model id on this deployment. Add it to HUB_MODEL_IDS, e.g. {"${model}": "eu.anthropic.…"} — the id or inference profile your AWS account shows for it.`,
    );
  }
  return model;
}

/** What is missing for the provider to be reached at all; null when nothing is. Names settings, never values. */
export function providerProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = modelProvider(env);
  if ("error" in p) return p.error;
  const ids = modelIdMap(env);
  if ("error" in ids) return ids.error;
  if (p.provider === "anthropic" && !env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY is not set — the agent runtime cannot reach Claude.";
  if (p.provider === "bedrock" && !env.AWS_REGION?.trim()) {
    return "HUB_MODEL_PROVIDER is bedrock but AWS_REGION is not set. It is required here: without it the SDK would use us-east-1.";
  }
  if (p.provider === "vertex") {
    if (!env.CLOUD_ML_REGION?.trim()) return "HUB_MODEL_PROVIDER is vertex but CLOUD_ML_REGION is not set (e.g. europe-west1, or eu).";
    if (!env.ANTHROPIC_VERTEX_PROJECT_ID?.trim()) return "HUB_MODEL_PROVIDER is vertex but ANTHROPIC_VERTEX_PROJECT_ID is not set.";
  }
  return null;
}

/** The region the provider runs in, for the deployment page; null for the Claude API (it has no region setting). */
export function providerRegion(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = modelProvider(env);
  if ("error" in p) return null;
  if (p.provider === "bedrock") return env.AWS_REGION?.trim() || null;
  if (p.provider === "vertex") return env.CLOUD_ML_REGION?.trim() || null;
  return null;
}

/** The part of a client the loop uses. Every provider's client has it. */
export interface ModelClient {
  messages: Pick<Anthropic["messages"], "stream">;
}

let client: Anthropic | null = null;
let providerClient: { key: string; client: ModelClient } | null = null;

// The first-party client. Kept behind a getter so importing the package never
// throws — only running does. The bench uses it directly (token counting).
export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — the agent runtime cannot reach Claude.");
  }
  if (!client) client = new Anthropic();
  return client;
}

/**
 * The client for this deployment's provider. The platform SDKs are loaded
 * only when named, so a deployment on the Claude API never loads the AWS or
 * Google libraries.
 */
export async function getModelClient(env: NodeJS.ProcessEnv = process.env): Promise<ModelClient> {
  const problem = providerProblem(env);
  if (problem) throw new Error(problem);
  const p = modelProvider(env) as { provider: ModelProvider };
  if (p.provider === "anthropic") return getAnthropic();
  const key = `${p.provider}:${providerRegion(env)}:${env.ANTHROPIC_VERTEX_PROJECT_ID ?? ""}`;
  if (providerClient?.key === key) return providerClient.client;
  let made: ModelClient;
  if (p.provider === "bedrock") {
    const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
    made = new AnthropicBedrock({ awsRegion: env.AWS_REGION!.trim() }) as unknown as ModelClient;
  } else {
    const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
    made = new AnthropicVertex({ region: env.CLOUD_ML_REGION!.trim(), projectId: env.ANTHROPIC_VERTEX_PROJECT_ID!.trim() }) as unknown as ModelClient;
  }
  providerClient = { key, client: made };
  return made;
}
