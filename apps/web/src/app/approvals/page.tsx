import { authorize } from "@ai-hub/authz";
import { listProposals, type Proposal } from "@ai-hub/db";
import { PageHeader } from "@/components/PageHeader";
import { peopleToSendTo } from "@/lib/approvals";
import { sessionCan } from "@/lib/sessionPrincipal";
import { ApprovalsView } from "./ApprovalsView";

export const dynamic = "force-dynamic";

/*
 * The Approvals page: every write an agent wanted to make and could not make
 * alone. A person reads what it would change and why, and says yes, no, or
 * "you decide" to a colleague. An admin sees all of them; anyone else sees
 * their own runs' writes and the ones sent to them.
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
  const scope = admin ? {} : { visibleTo: principal.id };

  let pending: Proposal[] = [];
  let decided: Proposal[] = [];
  let people: { id: string; name: string; email: string }[] = [];
  let error: string | null = null;
  try {
    [pending, decided, people] = await Promise.all([
      listProposals({ ...scope, status: ["pending", "approved"], limit: 200 }),
      listProposals({ ...scope, status: ["executed", "failed", "rejected"], limit: 100 }),
      peopleToSendTo(principal),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load the proposals.";
  }

  return (
    <main className="mx-auto max-w-[80rem] px-5 pb-32 pt-7 lg:px-8">
      {error ? (
        <>
          <PageHeader eyebrow="Approvals" title="Approvals" />
          <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">{error}</div>
        </>
      ) : (
        <ApprovalsView
          pending={pending}
          decided={decided}
          people={people}
          viewer={{ id: principal.id, admin }}
          now={Date.now()}
        />
      )}
    </main>
  );
}
