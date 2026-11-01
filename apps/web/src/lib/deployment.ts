import { modelIdMap, modelProvider, providerProblem, providerRegion } from "@ai-hub/agent";
import { isVendorEmail, vendorConfigured } from "@ai-hub/authz";

/*
 * This deployment, read from its own settings (docs/client-deployment.md):
 * where a client's data goes, and what is set up wrong. For the Admin page,
 * and for `npm run deploy:check -w web`, which a client's pipeline runs
 * before it deploys.
 *
 * Settings are read, never shown: a key is "set" or "not set", an address is
 * its host name. Nothing here sends anything anywhere — the hub has no call
 * home, and this is how a client can see that for themselves.
 */

export type PostureStatus = "ok" | "warn" | "bad";

export interface PostureItem {
  key: string;
  /** What it is, for someone who has never read an env file. */
  label: string;
  /** What this deployment has. */
  value: string;
  status: PostureStatus;
  /** What to do about it, when anything. */
  note?: string;
}

/** A party that receives the client's data on this deployment — the list a DPA's annex needs. */
export interface Recipient {
  who: string;
  what: string;
  where: string;
  /** Whose account it is under, as far as the settings can say. */
  account: string;
}

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** Whether a region name is in the EU/EEA, by the naming AWS, Google, Azure and Neon use. */
export function looksEuropean(region: string | null | undefined): boolean {
  if (!region) return false;
  const r = region.toLowerCase();
  return /(^|[^a-z])(eu|europe|ams|fra|arn|cdg|lhr|waw|mad|mil|zrh|dub|cph|hel|osl)([^a-z]|$)/.test(r) || r.startsWith("eu-") || r.startsWith("europe-") || r === "eu";
}

export function deploymentPosture(
  env: NodeJS.ProcessEnv = process.env,
  remotes: { name: string; url: string }[] = [],
): { items: PostureItem[]; recipients: Recipient[] } {
  const items: PostureItem[] = [];
  const recipients: Recipient[] = [];
  const set = (k: string) => Boolean(env[k]?.trim());

  // ── the model ────────────────────────────────────────────────────────────
  const provider = modelProvider(env);
  const problem = providerProblem(env);
  const region = providerRegion(env);
  if ("error" in provider) {
    items.push({ key: "model", label: "Where Claude runs", value: "not usable", status: "bad", note: provider.error });
  } else {
    const p = provider.provider;
    const name = p === "anthropic" ? "Anthropic (Claude API)" : p === "bedrock" ? "Amazon Bedrock" : "Google Vertex AI";
    items.push({
      key: "model",
      label: "Where Claude runs",
      value: region ? `${name}, ${region}` : name,
      status: problem ? "bad" : p !== "anthropic" && !looksEuropean(region) ? "warn" : "ok",
      note:
        problem ??
        (p === "anthropic"
          ? "Use the client's own API key, so they hold the contract. Check the account's data retention terms (zero data retention is available for this kind of use)."
          : looksEuropean(region)
            ? "In the client's own cloud account."
            : `${region} does not look like an EU region.`),
    });
    recipients.push({
      who: name,
      what: "Every question, retrieved passage, tool result and answer",
      where: region ?? (p === "anthropic" ? "Anthropic's API (no region setting)" : "region not set"),
      account: p === "anthropic" ? "whoever owns ANTHROPIC_API_KEY" : "the cloud account the hub runs as",
    });
  }
  const ids = modelIdMap(env);
  if ("error" in ids) items.push({ key: "model-ids", label: "Model names on that platform", value: "malformed", status: "bad", note: ids.error });

  // ── embeddings ───────────────────────────────────────────────────────────
  if (set("VOYAGE_API_KEY")) {
    items.push({ key: "embeddings", label: "Document search", value: "Voyage AI", status: "ok", note: "Use the client's own key, and check the account is opted out of data use." });
    recipients.push({ who: "Voyage AI", what: "The full text of every document, and every search", where: "Voyage's API", account: "whoever owns VOYAGE_API_KEY" });
  } else {
    items.push({ key: "embeddings", label: "Document search", value: "built-in fallback", status: "warn", note: "No VOYAGE_API_KEY: search runs but its results are not meaningful. Nothing leaves the hub for it." });
  }

  // ── tracing ──────────────────────────────────────────────────────────────
  if (set("LANGFUSE_PUBLIC_KEY") && set("LANGFUSE_SECRET_KEY")) {
    const host = hostOf(env.LANGFUSE_HOST ?? env.LANGFUSE_BASEURL) ?? "cloud.langfuse.com";
    const content = env.HUB_TRACE_CONTENT === "1";
    items.push({
      key: "tracing",
      label: "Tracing",
      value: content ? `full content, to ${host}` : `timings and costs only, to ${host}`,
      status: content ? "warn" : "ok",
      note: content ? "HUB_TRACE_CONTENT=1 sends every message and tool result. Only with a Langfuse the client runs." : undefined,
    });
    recipients.push({ who: "Langfuse", what: content ? "Every run in full" : "Tool names, token counts, cost and timing — no content", where: host, account: "whoever owns the Langfuse keys" });
  } else {
    items.push({ key: "tracing", label: "Tracing", value: "off", status: "ok" });
  }

  // ── sign-in and access ───────────────────────────────────────────────────
  const allowed = (env.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  items.push({
    key: "allowlist",
    label: "Who may sign in",
    value: allowed.length ? `${allowed.length} address${allowed.length === 1 ? "" : "es"}` : "nobody",
    status: allowed.length ? "ok" : "bad",
    note: allowed.length ? undefined : "ALLOWED_EMAILS is empty, so nobody can sign in.",
  });
  recipients.push({ who: "WorkOS", what: "Who signs in: name and email", where: "WorkOS (sign-in)", account: "the WorkOS environment in WORKOS_CLIENT_ID" });
  const vendorAllowlisted = allowed.filter((e) => isVendorEmail(e, env));
  items.push({
    key: "vendor",
    label: "The vendor's access",
    value: vendorConfigured(env) ? "temporary only" : "not named",
    status: vendorConfigured(env) ? "ok" : "warn",
    note: vendorConfigured(env)
      ? `The vendor gets in only through a grant with an end (Admin → Temporary access).${vendorAllowlisted.length ? ` ${vendorAllowlisted.length} of their addresses may sign in when granted.` : ""}`
      : "HUB_VENDOR_ACCESS is not set. On a client's own hub, set it to the vendor's domain so the vendor has no standing access. Leave it unset on the vendor's own hub.",
  });
  const auto = (env.HUB_AUTO_PROVISION_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  if (auto.length) items.push({ key: "auto", label: "Anyone at these domains gets analyst access on first sign-in", value: auto.join(", "), status: "ok" });

  // ── keys and storage ─────────────────────────────────────────────────────
  items.push({
    key: "secret",
    label: "The key connection tokens are sealed with",
    value: set("HUB_SECRET_KEY") ? "its own" : set("WORKOS_COOKIE_PASSWORD") ? "derived from the sign-in secret" : "none",
    status: set("HUB_SECRET_KEY") ? "ok" : set("WORKOS_COOKIE_PASSWORD") ? "warn" : "bad",
    note: set("HUB_SECRET_KEY") ? "Keep it in the client's secret store." : "Set HUB_SECRET_KEY from the client's secret store, before the first connection is added.",
  });
  const db = hostOf(env.DATABASE_URL);
  items.push({
    key: "database",
    label: "Database",
    value: db ?? "not set",
    status: db ? (looksEuropean(db) || !/(amazonaws|neon\.tech|azure|cloud\.google)/.test(db) ? "ok" : "warn") : "bad",
    note: db ? (looksEuropean(db) ? undefined : "Check the database is in an EU region, and that its backups' restore window matches the retention below.") : "DATABASE_URL is not set.",
  });
  if (db) recipients.push({ who: "The database", what: "Everything the hub keeps", where: db, account: "whoever owns the database" });
  const days = (k: string, d: number) => (/^\d+$/.test(env[k] ?? "") ? Number(env[k]) : d);
  items.push({
    key: "retention",
    label: "How long conversations are kept",
    value: `record ${days("HUB_RETAIN_TRANSCRIPTS_DAYS", 7)} days, question and answer ${days("HUB_RETAIN_ANSWERS_DAYS", 90)} days, audit ${days("HUB_RETAIN_AUDIT_DAYS", 365)} days`,
    status: "ok",
  });
  const open = env.HUB_DEFAULT_COLLECTION_VISIBILITY === "open";
  items.push({
    key: "visibility",
    label: "Documents nobody has classified",
    value: open ? "readable by everyone signed in" : "private until granted",
    status: open ? "warn" : "ok",
  });

  // ── what is installed ────────────────────────────────────────────────────
  const seeds = env.HUB_SEEDS?.trim();
  items.push({
    key: "seeds",
    label: "Agents installed with every release",
    value: !seeds ? "all of the vendor's" : seeds === "none" ? "none" : seeds,
    status: !seeds && vendorConfigured(env) ? "warn" : "ok",
    note: !seeds && vendorConfigured(env) ? "This looks like a client's hub (HUB_VENDOR_ACCESS is set) but it installs every agent the vendor uses itself. Set HUB_SEEDS, e.g. context-steward, or none." : undefined,
  });

  // ── the systems it is connected to ───────────────────────────────────────
  if (set("M365_TENANT_ID")) recipients.push({ who: "Microsoft 365", what: "What agents read from and propose to the mailbox and Teams", where: "Microsoft Graph", account: `the client's tenant` });
  for (const r of remotes) {
    recipients.push({ who: r.name, what: "What agents send to and read from this connection", where: hostOf(r.url) ?? "unknown", account: "the connection's own" });
  }
  recipients.push({
    who: "People's own Claude accounts",
    what: "What the hub's MCP server returns: search results, documents, answers — never anything labelled confidential",
    where: "Claude Code / Claude.ai",
    account: "each person's own plan",
  });

  return { items, recipients };
}

/** The worst status among the items. */
export const worst = (items: PostureItem[]): PostureStatus =>
  items.some((i) => i.status === "bad") ? "bad" : items.some((i) => i.status === "warn") ? "warn" : "ok";
