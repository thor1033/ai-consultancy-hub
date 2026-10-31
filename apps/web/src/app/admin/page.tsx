import { AdminConsole } from "./AdminConsole";
import { AccessPanel } from "./AccessPanel";
import { PageHeader } from "@/components/PageHeader";
import { viewContext } from "@/lib/viewServer";

export const dynamic = "force-dynamic";

// The control plane (admin-gated). Two halves, gated differently on purpose.
//
// Access — people, credentials, the audit trail — is gated on the WorkOS
// session, because it is where credentials are issued and so cannot itself
// require one. The MCP registry below it still takes an admin bearer token; it
// is the older gate and moving it is a separate change from this one.
export default async function AdminPage() {
  // Below Expert: people and what they may read, in plain words. The tool
  // server registry takes an admin bearer token, so it stays with Expert.
  const expert = (await viewContext()).view === "expert";
  return (
    <main className="mx-auto max-w-[80rem] space-y-12 px-5 py-7 lg:px-8">
      <div>
        <PageHeader
          eyebrow={expert ? "Control plane" : "Admin"}
          title={expert ? "Access" : "People and access"}
          subtitle={
            expert
              ? "Who can reach the hub, what they can reach it with, and what happened. OAuth is the front door; credentials are for the clients that cannot use it."
              : "Who may use the hub and which documents they may read. Machine access, sign-in settings and the audit trail are in the Expert view."
          }
        />
        <AccessPanel />
      </div>

      {expert && (
      <div>
        <PageHeader
          eyebrow="Control plane"
          title="MCP servers"
          subtitle="Enable or disable the tool servers agents connect to. Changes take effect on the next run."
        />
        <AdminConsole />
      </div>
      )}
    </main>
  );
}
