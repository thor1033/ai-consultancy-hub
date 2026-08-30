"use server";

import { setMcpServerEnabled, deleteMcpServer } from "@ai-hub/db";
import { authorizeToken } from "@/lib/authz";
import { listRegisteredServers, declaredRemoteNames } from "@/lib/mcpCatalog";
import type { AdminMcp, Registry } from "./types";

// Server actions for the MCP control plane. Every action re-verifies an admin
// bearer token (admin:manage) before touching state: the console asks for the
// token rather than trusting the WorkOS session, because these are the switches
// that decide what every agent can reach.

type Result<T> = T | { error: string };

const DENIED = "Not authorized. Enter a valid admin token.";

async function buildRegistry(): Promise<Registry> {
  const [servers, declared] = await Promise.all([
    listRegisteredServers(),
    Promise.resolve(declaredRemoteNames()),
  ]);
  const mcpServers: AdminMcp[] = servers.map((srv) => ({
    name: srv.name,
    label: srv.label,
    description: srv.description,
    enabled: srv.enabled,
    declared: declared.includes(srv.name),
  }));
  return { mcpServers };
}

export async function loadRegistryAction(token: string): Promise<Result<Registry>> {
  if (!(await authorizeToken(token, "admin:manage"))) return { error: DENIED };
  try {
    return await buildRegistry();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to load the registry." };
  }
}

export async function setMcpEnabledAction(
  token: string,
  name: string,
  enabled: boolean,
): Promise<Result<Registry>> {
  if (!(await authorizeToken(token, "admin:manage"))) return { error: DENIED };
  try {
    const ok = await setMcpServerEnabled(name, enabled);
    if (!ok) return { error: "MCP server not found." };
    return await buildRegistry();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Update failed." };
  }
}

export async function deleteMcpServerAction(
  token: string,
  name: string,
): Promise<Result<Registry>> {
  if (!(await authorizeToken(token, "admin:manage"))) return { error: DENIED };
  try {
    const ok = await deleteMcpServer(name);
    if (!ok) return { error: "MCP server not found." };
    // Rebuilding re-runs the upsert of declared remotes, so a declared server
    // reappears here immediately. That is the honest result of deleting one, and
    // showing it is better than a list that disagrees with the database.
    return await buildRegistry();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Delete failed." };
  }
}
