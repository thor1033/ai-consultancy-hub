"use server";

import { revalidatePath } from "next/cache";
import { getMemory, setMemoryActiveById, setMemoryRegionById, MEMORY_REGIONS, type MemoryRegion } from "@ai-hub/db";
import { sessionCan, sessionPrincipal } from "@/lib/sessionPrincipal";

const NOT_ALLOWED = "You do not have permission to change an agent's memory.";

/**
 * By memory id: a key can name several memories now, one per scope
 * (docs/memory-scopes.md). Someone who manages agents may change any; anyone
 * may change their own personal memory.
 */
async function mayChange(memoryId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const principal = await sessionPrincipal();
  if (!principal) return { ok: false, error: NOT_ALLOWED };
  const m = await getMemory(memoryId);
  if (!m) return { ok: false, error: "That memory no longer exists." };
  const own = m.scope === "personal" && m.scopeRef === principal.id;
  if (!own && !(await sessionCan("agent:manage"))) return { ok: false, error: NOT_ALLOWED };
  return { ok: true };
}

export async function setContextMemoryActiveAction(memoryId: string, active: boolean): Promise<{ ok: boolean; error?: string }> {
  const may = await mayChange(memoryId);
  if (!may.ok) return may;
  const ok = await setMemoryActiveById(memoryId, active);
  revalidatePath("/context");
  revalidatePath("/agents");
  return ok ? { ok } : { ok, error: "That memory no longer exists." };
}

export async function setContextMemoryRegionAction(memoryId: string, region: string | null): Promise<{ ok: boolean; error?: string }> {
  const may = await mayChange(memoryId);
  if (!may.ok) return may;
  if (region !== null && !(MEMORY_REGIONS as readonly string[]).includes(region)) {
    return { ok: false, error: "Unknown region." };
  }
  const ok = await setMemoryRegionById(memoryId, region as MemoryRegion | null);
  revalidatePath("/context");
  return ok ? { ok } : { ok, error: "That memory no longer exists." };
}
