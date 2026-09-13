import { AdminConsole } from "./AdminConsole";
import { AccessPanel } from "./AccessPanel";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

// The control plane (admin-gated). Two halves, gated differently on purpose.
//
// Access — people, credentials, the audit trail — is gated on the WorkOS
// session, because it is where credentials are issued and so cannot itself
// require one. The MCP registry below it still takes an admin bearer token; it
// is the older gate and moving it is a separate change from this one.
export default function AdminPage() {
  return (
    <main className="mx-auto max-w-[80rem] space-y-12 px-5 py-7 lg:px-8">
      <div>
        <PageHeader
          eyebrow="Control plane"
          title="Access"
          subtitle="Who can reach the hub, what they can reach it with, and what happened. OAuth is the front door; credentials are for the clients that cannot use it."
        />
        <AccessPanel />
      </div>

      <div>
        <PageHeader
          eyebrow="Control plane"
          title="MCP servers"
          subtitle="Enable or disable the tool servers agents connect to. Changes take effect on the next run."
        />
        <AdminConsole />
      </div>
    </main>
  );
}
