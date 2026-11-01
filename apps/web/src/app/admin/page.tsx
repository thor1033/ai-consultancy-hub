import { AdminConsole } from "./AdminConsole";
import { AccessPanel } from "./AccessPanel";
import { PageHeader } from "@/components/PageHeader";
import { viewContext } from "@/lib/viewServer";
import { sessionCan, standingAdmin } from "@/lib/sessionPrincipal";
import {
  lastRetentionSweep,
  listKnowledgeReads,
  listPrincipals,
  listTemporaryAccess,
  retentionPolicy,
  type KnowledgeReadRow,
  type TemporaryAccessRow,
} from "@ai-hub/db";
import { remoteServerInfo } from "@ai-hub/mcp";
import { DataPanel } from "./DataPanel";
import { TemporaryAccess } from "./TemporaryAccess";
import { DeploymentPanel } from "./DeploymentPanel";
import { deploymentPosture } from "@/lib/deployment";
import { loadHubConnections } from "@/lib/connections";

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
  // People's data is loaded here, on the server, so it is shown to admins only —
  // the panel above fetches through its own admin-checked actions. Temporary
  // admins (docs/client-deployment.md) see the deployment and their own grant,
  // not other people's data.
  const admin = Boolean(await sessionCan("admin:manage"));
  const standing = Boolean(await standingAdmin());
  const temporary = admin ? await listTemporaryAccess().catch(() => [] as TemporaryAccessRow[]) : [];
  if (admin && expert) await loadHubConnections();
  const posture = admin && expert ? deploymentPosture(process.env, remoteServerInfo().map((r) => ({ name: r.label || r.name, url: r.url }))) : null;
  const [people, lastSweep, reads] = standing
    ? await Promise.all([
        listPrincipals().catch(() => []),
        lastRetentionSweep().catch(() => null),
        listKnowledgeReads({ limit: 100 }).catch(() => [] as KnowledgeReadRow[]),
      ])
    : [[], null, [] as KnowledgeReadRow[]];
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

      {admin && (
        <div>
          <PageHeader
            eyebrow={expert ? "Control plane" : "Admin"}
            title="Temporary access"
            subtitle="Access that ends by itself — for the vendor, or anyone, when something needs fixing. Who has it, why, until when, and what they did with it."
          />
          <TemporaryAccess
            rows={temporary.map((r) => ({
              ...r,
              expiresAt: new Date(r.expiresAt).toISOString(),
              grantedAt: r.grantedAt ? new Date(r.grantedAt).toISOString() : null,
            }))}
            canGrant={standing}
          />
        </div>
      )}

      {standing && (
        <div>
          <PageHeader
            eyebrow={expert ? "Control plane" : "Admin"}
            title="People's data"
            subtitle="How long the hub keeps what people asked and were answered, and each person's right to a copy of their data or to have it erased."
          />
          <DataPanel
            policy={retentionPolicy()}
            lastSweep={lastSweep ? { at: new Date(lastSweep.at).toISOString(), detail: lastSweep.detail } : null}
            people={people.map((p) => ({ id: p.id, email: p.email, name: p.displayName }))}
            reads={reads.map((r) => ({ ...r, at: new Date(r.at).toISOString() }))}
          />
        </div>
      )}

      {/* Expert only: it names settings, which the simpler views never show (docs/views.md). */}
      {posture && expert && (
        <div>
          <PageHeader
            eyebrow={expert ? "Control plane" : "Admin"}
            title="This deployment"
            subtitle="Where your organisation's data goes from this hub, read from its own settings, and anything set up wrong. The hub sends nothing anywhere else."
          />
          <DeploymentPanel items={posture.items} recipients={posture.recipients} />
        </div>
      )}

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
