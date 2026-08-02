"use server";

import { listMcpServers } from "@ai-hub/db";
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
