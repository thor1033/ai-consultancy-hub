import { authorize } from "@ai-hub/authz";
import { listProposals, type Proposal } from "@ai-hub/db";
import { PageHeader } from "@/components/PageHeader";
import { sessionCan } from "@/lib/sessionPrincipal";
import { ApprovalsView } from "./ApprovalsView";

export const dynamic = "force-dynamic";

/*
 * The Approvals page: every write an agent wanted to make and could not make
 * alone. A person reads the exact call — tool, server, arguments — and says
 * yes or no. An admin sees all of them; anyone else sees the ones whose runs
 * acted as them, since those are the writes they would have been making.
 */
export default async function ApprovalsPage() {
  const principal = await sessionCan("agent:run");
  if (!principal) {
    return (
      <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
        <PageHeader eyebrow="Approvals" title="Approvals" />
        <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">
          Your role does not include the agents, so there is nothing here for you to approve.
        </div>
      </main>
    );
  }
  const admin = await authorize(principal, "admin:manage");
  const scope = admin ? {} : { principalId: principal.id };

  let pending: Proposal[] = [];
  let decided: Proposal[] = [];
  let error: string | null = null;
  try {
    [pending, decided] = await Promise.all([
      listProposals({ ...scope, status: ["pending", "approved"], limit: 100 }),
      listProposals({ ...scope, status: ["executed", "failed", "rejected"], limit: 40 }),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load the proposals.";
  }

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Approvals"
        title="Approvals"
        subtitle={
          admin
            ? "Every write an agent wanted to make. Nothing here has happened yet; approving runs the exact call shown."
            : "Writes that agents wanted to make while acting as you. Nothing here has happened yet; approving runs the exact call shown."
        }
      />
      {error ? (
        <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">{error}</div>
      ) : (
        <ApprovalsView pending={pending} decided={decided} viewerId={principal.id} />
      )}
    </main>
  );
}
