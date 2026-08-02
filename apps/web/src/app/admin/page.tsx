import { AdminConsole } from "./AdminConsole";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

// The MCP / Skill control plane (admin-gated). View which servers and skills are
// enabled, flip them on or off (a disabled item is dropped from every run), and
// see why each skill can be run — the roles allowed plus any explicit grants.
export default function AdminPage() {
  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Control plane"
        title="MCP servers & Skills"
        subtitle="Enable or disable MCP servers and Skills, and see who can run what. Changes take effect on the next run."
      />
      <AdminConsole />
    </main>
  );
}
