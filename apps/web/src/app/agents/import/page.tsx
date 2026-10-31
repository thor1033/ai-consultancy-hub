import Link from "next/link";
import { agentOrgLabels } from "@ai-hub/db";
import { sessionCan } from "@/lib/sessionPrincipal";
import { ImportForm } from "./ImportForm";

export const dynamic = "force-dynamic";

// Importing an agent file from GitHub: a SKILL.md (the Agent Skills standard)
// or a sub-agent brief from one of the open collections (docs/skill-import.md).

export default async function ImportPage() {
  const [canManage, orgLabels] = await Promise.all([sessionCan("agent:manage"), agentOrgLabels().catch(() => ({ functions: [], owners: [] }))]);
  return (
    <main className="mx-auto max-w-[70rem] px-5 py-7 lg:px-8">
      <Link href="/agents" className="text-sm text-[var(--muted)] hover:text-[var(--brand-ink)]">
        ← Agents
      </Link>
      <header className="mt-3">
        <div className="eyebrow">Agents / Import</div>
        <h1 className="mt-3 text-3xl md:text-4xl">Bring one in from GitHub.</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          A SKILL.md from the open Agent Skills collections, or an agent&apos;s brief from a sub-agent library. The hub reads it, shows you every
          line, and makes it an agent or a skill only when you say so — with where it came from and its license kept on the row.
        </p>
      </header>
      <ImportForm canManage={Boolean(canManage)} functions={orgLabels.functions} owners={orgLabels.owners} />
    </main>
  );
}
