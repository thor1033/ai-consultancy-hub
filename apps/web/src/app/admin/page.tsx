import Link from "next/link";
import { AdminConsole } from "./AdminConsole";

export const dynamic = "force-dynamic";

// The MCP / Skill control plane (admin-gated). View which servers and skills are
// enabled, flip them on or off (a disabled item is dropped from every run), and
// see why each skill can be run — the roles allowed plus any explicit grants.
export default function AdminPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Skills
      </Link>

      <header className="mt-6 mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Control plane</h1>
        <p className="mt-1 text-neutral-400">
          Enable or disable MCP servers and Skills, and see who can run what.
          Changes take effect on the next run.
        </p>
      </header>

      <AdminConsole />
    </main>
  );
}
