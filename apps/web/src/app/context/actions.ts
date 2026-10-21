"use server";

import { revalidatePath } from "next/cache";
import { setMemoryActive, setMemoryRegion, MEMORY_REGIONS, type MemoryRegion } from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";

const NOT_ALLOWED = "You do not have permission to change an agent's memory.";

export async function setContextMemoryActiveAction(
  agentId: string,
  key: string,
  active: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await sessionCan("agent:manage"))) return { ok: false, error: NOT_ALLOWED };
  const ok = await setMemoryActive(agentId, key, active);
  revalidatePath("/context");
  revalidatePath("/agents");
  return ok ? { ok } : { ok, error: "That memory no longer exists." };
}

export async function setContextMemoryRegionAction(
  agentId: string,
  key: string,
  region: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await sessionCan("agent:manage"))) return { ok: false, error: NOT_ALLOWED };
  if (region !== null && !(MEMORY_REGIONS as readonly string[]).includes(region)) {
    return { ok: false, error: "Unknown region." };
  }
  const ok = await setMemoryRegion(agentId, key, region as MemoryRegion | null);
  revalidatePath("/context");
  return ok ? { ok } : { ok, error: "That memory no longer exists." };
}
