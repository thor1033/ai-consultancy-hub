import { knownServers } from "@/lib/runSession";
import { Workbench } from "./Workbench";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

// The Skillification workbench (docs/04): a practitioner runs their real workflow
// once, end-to-end, with the MCP servers it needs — then turns that session into
// a reusable Skill anyone can run.
export default function WorkbenchPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Workbench"
        title="Skillification"
        subtitle="Do the work once, end-to-end, with the tools it needs. Then capture the session as a reusable Skill."
      />
      <Workbench servers={knownServers()} />
    </main>
  );
}
