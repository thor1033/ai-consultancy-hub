import Link from "next/link";
import { KNOWN_SERVERS } from "@/lib/runSession";
import { Workbench } from "./Workbench";

export const dynamic = "force-dynamic";

// The Skillification workbench (docs/04): a practitioner runs their real workflow
// once, end-to-end, with the MCP servers it needs — then turns that session into
// a reusable Skill anyone can run.
export default function WorkbenchPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Skills
      </Link>

      <header className="mt-6 mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Skillification workbench</h1>
        <p className="mt-1 text-neutral-400">
          Do the work once, end-to-end, with the tools it needs. Then capture the
          session as a reusable Skill.
        </p>
      </header>

      <Workbench servers={[...KNOWN_SERVERS]} />
    </main>
  );
}
