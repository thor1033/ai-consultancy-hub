import { listBriefs, listRunnableSkills, listSchedules, type Brief, type Schedule, type SkillWithAgent } from "@ai-hub/db";
import { PageHeader } from "@/components/PageHeader";
import { sessionCan } from "@/lib/sessionPrincipal";
import { BriefsView } from "./BriefsView";
import { standingArgs } from "./standing";

export const dynamic = "force-dynamic";

/*
 * The Briefs page: what an agent prepared for you to read, rather than what it
 * answered when asked. The morning meeting prep lives here. A brief is a run
 * of a skill whose kind is `brief`; this page lists those runs newest first,
 * lets a person run one now, and lets them put it on their own morning clock.
 */
export default async function BriefsPage() {
  const principal = await sessionCan("agent:run");
  if (!principal) {
    return (
      <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
        <PageHeader eyebrow="Briefs" title="Briefs" />
        <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">
          Your role does not include the agents, so their briefs are not shown.
        </div>
      </main>
    );
  }

  let briefs: Brief[] = [];
  let skills: SkillWithAgent[] = [];
  let schedules: Schedule[] = [];
  let error: string | null = null;
  try {
    [briefs, skills, schedules] = await Promise.all([listBriefs(30), listRunnableSkills(), listSchedules()]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load the briefs.";
  }

  // The hub runs only hub-placed agents; a brief on a local-only agent has no
  // clock and no Run now, so it is not offered here.
  const briefSkills = skills
    .filter((s) => s.kind === "brief" && s.agentPlacement !== "local")
    .map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description,
      agentName: s.agentName,
      agentSlug: s.agentSlug,
      schedulable: standingArgs(s) !== null,
      mine: schedules.find((c) => c.agentSkillId === s.id && c.ownerPrincipalId === principal.id) ?? null,
      others: schedules.filter((c) => c.agentSkillId === s.id && c.ownerPrincipalId !== principal.id && c.enabled).length,
    }));

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Briefs"
        title="Briefs"
        subtitle="What the agents prepared for you to read: the morning meeting prep, and anything else set up to publish rather than answer."
      />
      {error ? (
        <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">{error}</div>
      ) : (
        <BriefsView
          briefs={briefs}
          skills={briefSkills}
          timezone={process.env.HUB_TIMEZONE?.trim() || "UTC"}
          viewerId={principal.id}
        />
      )}
    </main>
  );
}
