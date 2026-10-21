"use server";

import { revalidatePath } from "next/cache";
import { listMcpServers, setMcpServerEnabled } from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";
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
