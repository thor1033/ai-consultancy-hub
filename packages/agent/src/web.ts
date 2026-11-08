import type Anthropic from "@anthropic-ai/sdk";
import type { ModelId } from "./models";

/*
 * The web, as a tool an agent may be given (docs/web.md).
 *
 * Web search and web fetch are the Claude API's own server tools: the model
 * asks, Anthropic runs the search or the fetch and hands the results back
 * inside the same request, with citations. Nothing runs in the hub, no new
 * vendor sees a query, and no key beyond the deployment's model key is
 * needed — which is also why they exist only on the Anthropic provider
 * (packages/agent/src/client.ts): on Bedrock or Vertex the hub says the web
 * is unavailable rather than quietly answering from training data.
 *
 * What bounds a run's reading: how many searches and fetches it may make
 * (every search is billed), and which sites it may or may not read.
 */

export interface WebAccess {
  /** Search the web. Default true. */
  search?: boolean;
  /** Read a page the run has a URL for. Default true. */
  fetch?: boolean;
  /** Searches one run may make. Default DEFAULT_WEB_SEARCHES; the API's ceiling applies above that. */
  maxSearches?: number;
  /** Pages one run may fetch. Default DEFAULT_WEB_FETCHES. */
  maxFetches?: number;
  /** Only these sites (and their subdomains). Exclusive with blockedDomains. */
  allowedDomains?: string[];
  /** Never these sites. */
  blockedDomains?: string[];
}

export const DEFAULT_WEB_SEARCHES = 8;
export const DEFAULT_WEB_FETCHES = 8;
/** What a search costs beyond tokens: USD 10 per 1,000 searches on the Claude API. Fetches are tokens only. */
export const WEB_SEARCH_USD = 0.01;

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_FETCH_TOOL = "web_fetch";

/** Whether the model can use the dynamic-filtering variants (Opus 4.6+, Sonnet 4.6+). Older models get the basic search only. */
const current = (model: string) => !/haiku-4-5|opus-4-5|sonnet-4-5/.test(model);

/** Hostnames only, lowercase, deduplicated: what the API accepts. */
export function cleanDomains(list: readonly string[] | undefined): string[] | undefined {
  if (!list) return undefined;
  const out = [...new Set(list.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];
  return out.length ? out.slice(0, 64) : undefined;
}

/** The server tools for this access on this model, in the shape the Messages API takes. */
export function webTools(model: ModelId | string, web: WebAccess): Anthropic.ToolUnion[] {
  const tools: Anthropic.ToolUnion[] = [];
  const allowed = cleanDomains(web.allowedDomains);
  // One list or the other: the API rejects both, and "only these" is the stricter wish.
  const blocked = allowed ? undefined : cleanDomains(web.blockedDomains);
  const domains = { ...(allowed ? { allowed_domains: allowed } : {}), ...(blocked ? { blocked_domains: blocked } : {}) };
  if (web.search !== false) {
    tools.push({
      type: current(model) ? "web_search_20260209" : "web_search_20250305",
      name: WEB_SEARCH_TOOL,
      max_uses: Math.max(1, Math.min(50, Math.trunc(web.maxSearches ?? DEFAULT_WEB_SEARCHES))),
      ...domains,
    } as Anthropic.ToolUnion);
  }
  // Fetch rides on the current variants only; an older model searches and reads the snippets.
  if (web.fetch !== false && current(model)) {
    tools.push({
      type: "web_fetch_20260209",
      name: WEB_FETCH_TOOL,
      max_uses: Math.max(1, Math.min(50, Math.trunc(web.maxFetches ?? DEFAULT_WEB_FETCHES))),
      ...domains,
    } as Anthropic.ToolUnion);
  }
  return tools;
}

/** The reading a response did: server tool calls by name. */
export function webUseIn(content: readonly { type: string; name?: string }[]): { searches: number; fetches: number } {
  let searches = 0;
  let fetches = 0;
  for (const b of content) {
    if (b.type !== "server_tool_use") continue;
    if (b.name === WEB_SEARCH_TOOL) searches++;
    else if (b.name === WEB_FETCH_TOOL) fetches++;
  }
  return { searches, fetches };
}
