"use server";

import { revalidatePath } from "next/cache";
import { createHubConnection, deleteHubConnection, listHubConnections, listMcpServers, setMcpServerEnabled, updateHubConnection } from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";
import { CONNECTION_NAME, checkConnectionUrl, connectionName, loadHubConnections, reservedConnectionName, tokenPurpose, urlPurpose } from "@/lib/connections";
import { openSecret, sealSecret } from "@/lib/secretBox";
import { probeServer } from "@/lib/mcpCatalog";
import type { McpNavItem } from "./types";

// Lightweight registry list for the sidebar's live MCP section. Cheap — no tool
// introspection here (that happens on the detail page).
export async function listMcpServersAction(): Promise<McpNavItem[]> {
  try {
    const servers = await listMcpServers();
    return servers.map((s) => ({ name: s.name, label: s.label || s.name, enabled: s.enabled }));
  } catch {
    return [];
  }
}

/**
 * The kill switch, from the server's own page. Switching a server off drops it
 * from every run at once, so it needs admin:manage — the same permission the
 * control plane's token-guarded toggle checks.
 */
export async function setServerEnabledAction(
  name: string,
  enabled: boolean,
): Promise<{ ok: true } | { error: string }> {
  if (!(await sessionCan("admin:manage"))) return { error: "Only an admin can switch a tool server on or off." };
  try {
    if (!(await setMcpServerEnabled(name, enabled))) return { error: "That server is not in the registry." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not change the server." };
  }
  revalidatePath("/mcp");
  revalidatePath(`/mcp/${name}`);
  revalidatePath("/");
  return { ok: true };
}

// --- Connections added on this page (docs/connections.md) -------------------
//
// A remote MCP server declared from the browser instead of in
// HUB_REMOTE_MCP_SERVERS, so hooking up a client's system needs no deploy.
// Admin-only, like the switch above: a connection is a new place every agent
// given it will send what it reads and writes. The address and token are
// sealed before they are stored (lib/secretBox.ts) and never sent back to a
// page — editing one means typing a new one.

export type ConnectionResult =
  | { ok: true; name: string; tools: number | null }
  | { error: string; canForce?: boolean };

const NOT_ADMIN = "Only an admin can add or change a connection.";
const MAX_TOKEN = 8_192;

/** Dial it before saving, so a typo is found now rather than in an agent's run. */
async function probe(name: string, url: string, token: string | null): Promise<{ tools: number } | { error: string }> {
  try {
    const tools = await probeServer({ name, url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { tools };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: /401|403|Unauthorized|Forbidden/i.test(msg) ? `It answered, but refused the token: ${msg}` : `Could not reach it: ${msg}` };
  }
}

function seal(value: string, purpose: string): string | { error: string } {
  try {
    return sealSecret(value, purpose);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not encrypt it." };
  }
}

export async function addConnectionAction(input: {
  label: string;
  name?: string;
  url: string;
  token?: string;
  description?: string;
  /** Save even though it did not answer just now. */
  force?: boolean;
}): Promise<ConnectionResult> {
  const principal = await sessionCan("admin:manage");
  if (!principal) return { error: NOT_ADMIN };
  await loadHubConnections();
  const label = (input.label ?? "").replace(/\s+/g, " ").trim();
  if (!label) return { error: "Give it a name people will recognise, like \"CRM\" or \"Project board\"." };
  if (label.length > 60) return { error: "The name is too long (60 characters at most)." };
  const name = (input.name ?? "").trim() || connectionName(label);
  if (!CONNECTION_NAME.test(name)) return { error: "The short name must be 2–40 lowercase letters, digits and hyphens." };
  const reserved = reservedConnectionName(name);
  if (reserved) return { error: reserved };
  const url = checkConnectionUrl(input.url ?? "");
  if ("error" in url) return url;
  const token = (input.token ?? "").trim() || null;
  if (token && token.length > MAX_TOKEN) return { error: "That token is too long to be one." };
  const description = (input.description ?? "").trim().slice(0, 500);

  let tools: number | null = null;
  if (!input.force) {
    const p = await probe(name, url.url, token);
    if ("error" in p) return { error: p.error, canForce: true };
    tools = p.tools;
  }
  const urlSealed = seal(url.url, urlPurpose(name));
  if (typeof urlSealed !== "string") return urlSealed;
  const tokenSealed = token ? seal(token, tokenPurpose(name)) : null;
  if (tokenSealed !== null && typeof tokenSealed !== "string") return tokenSealed;
  try {
    const created = await createHubConnection({ name, label, description, urlSealed, tokenSealed, addedBy: principal.email ?? principal.id });
    if (!created) return { error: `There is already a server called "${name}". Choose another short name.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save the connection." };
  }
  await loadHubConnections({ force: true });
  revalidatePath("/mcp");
  revalidatePath("/");
  return { ok: true, name, tools };
}

export async function updateConnectionAction(
  name: string,
  input: { label?: string; description?: string; url?: string; token?: string; removeToken?: boolean; force?: boolean },
): Promise<ConnectionResult> {
  if (!(await sessionCan("admin:manage"))) return { error: NOT_ADMIN };
  const row = (await listHubConnections()).find((r) => r.name === name);
  if (!row) return { error: "That is not a connection added on this page." };
  const label = input.label === undefined ? undefined : input.label.replace(/\s+/g, " ").trim();
  if (label !== undefined && (!label || label.length > 60)) return { error: "Give it a name of 1–60 characters." };
  const newUrl = input.url?.trim() ? checkConnectionUrl(input.url) : null;
  if (newUrl && "error" in newUrl) return newUrl;
  const newToken = input.token?.trim() || null;
  if (newToken && newToken.length > MAX_TOKEN) return { error: "That token is too long to be one." };

  let tools: number | null = null;
  const dialChanges = Boolean(newUrl || newToken || input.removeToken);
  if (dialChanges && !input.force) {
    // Dial with what it will have after the save: the new value where one was
    // typed, else the stored one (opened here, never sent to the page).
    let url: string;
    let token: string | null;
    try {
      url = newUrl ? newUrl.url : openSecret(row.urlSealed, urlPurpose(name));
      token = input.removeToken ? null : (newToken ?? (row.tokenSealed ? openSecret(row.tokenSealed, tokenPurpose(name)) : null));
    } catch (e) {
      return { error: `The saved address or token cannot be read (${e instanceof Error ? e.message : String(e)}). Type both again.` };
    }
    const p = await probe(name, url, token);
    if ("error" in p) return { error: p.error, canForce: true };
    tools = p.tools;
  }
  const urlSealed = newUrl ? seal(newUrl.url, urlPurpose(name)) : undefined;
  if (urlSealed !== undefined && typeof urlSealed !== "string") return urlSealed;
  const tokenSealed = input.removeToken ? null : newToken ? seal(newToken, tokenPurpose(name)) : undefined;
  if (tokenSealed && typeof tokenSealed !== "string") return tokenSealed;
  try {
    await updateHubConnection(name, {
      label,
      description: input.description === undefined ? undefined : input.description.trim().slice(0, 500),
      urlSealed: urlSealed as string | undefined,
      tokenSealed: tokenSealed as string | null | undefined,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save the connection." };
  }
  await loadHubConnections({ force: true });
  revalidatePath("/mcp");
  revalidatePath(`/mcp/${name}`);
  return { ok: true, name, tools };
}

/** Remove a connection. Agents that had it keep the entry; their runs say it is gone. */
export async function removeConnectionAction(name: string): Promise<{ ok: true } | { error: string }> {
  if (!(await sessionCan("admin:manage"))) return { error: NOT_ADMIN };
  try {
    if (!(await deleteHubConnection(name))) return { error: "That is not a connection added on this page." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not remove the connection." };
  }
  await loadHubConnections({ force: true });
  revalidatePath("/mcp");
  revalidatePath("/");
  return { ok: true };
}
