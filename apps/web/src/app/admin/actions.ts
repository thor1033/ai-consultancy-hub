"use server";

import {
  listSkillsAdmin,
  setSkillEnabled,
  setMcpServerEnabled,
  type McpEntry,
} from "@ai-hub/db";
import { rolesForAction } from "@ai-hub/authz";
import { authorizeToken } from "@/lib/authz";
import { listRegisteredServers } from "@/lib/mcpCatalog";
import type { AdminSkill, AdminMcp, Registry } from "./types";

// Server actions for the MCP/Skill control plane. Every action re-verifies an
// admin bearer token (admin:manage) before touching state — the console is
// admin-gated even though the browser has no session yet (WorkOS SSO, Phase 2).

type Result<T> = T | { error: string };

const DENIED = "Not authorized. Enter a valid admin token.";

function serverNames(entries: McpEntry[]): string[] {
  return entries
    .map((e) => (typeof e.name === "string" ? e.name : null))
    .filter((n): n is string => n !== null);
}

async function buildRegistry(): Promise<Registry> {
  const [skills, servers] = await Promise.all([listSkillsAdmin(), listRegisteredServers()]);
  const runnableRoles = rolesForAction("skill:run");

  const adminSkills: AdminSkill[] = skills.map((s) => ({
    slug: s.slug,
    name: s.name,
    enabled: s.enabled,
    latestVersion: s.latestVersion,
    mcpServers: serverNames(s.mcpServers),
    runnableRoles,
    grantedPrincipals: s.grantedPrincipals,
  }));

  const mcpServers: AdminMcp[] = servers.map((srv) => ({
    name: srv.name,
    label: srv.label,
    description: srv.description,
    enabled: srv.enabled,
    usedBySkills: adminSkills
      .filter((s) => s.mcpServers.includes(srv.name))
      .map((s) => s.name),
  }));

  return { skills: adminSkills, mcpServers };
}

export async function loadRegistryAction(token: string): Promise<Result<Registry>> {
  if (!(await authorizeToken(token, "admin:manage"))) return { error: DENIED };
  try {
    return await buildRegistry();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to load the registry." };
  }
}

export async function setSkillEnabledAction(
  token: string,
  slug: string,
  enabled: boolean,
): Promise<Result<Registry>> {
  if (!(await authorizeToken(token, "admin:manage"))) return { error: DENIED };
  try {
    const ok = await setSkillEnabled(slug, enabled);
    if (!ok) return { error: "Skill not found." };
    return await buildRegistry();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Update failed." };
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
