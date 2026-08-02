import Link from "next/link";
import { listSkills, roiSummary, roiDaily } from "@ai-hub/db";
import { valueRoi, fmtUsd, fmtHours } from "@/lib/roi";
import { Sparkline } from "@/components/Charts";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let skills: Awaited<ReturnType<typeof listSkills>> = [];
  let skillsError: string | null = null;
  try {
    skills = await listSkills();
  } catch (e) {
    skillsError = e instanceof Error ? e.message : "Failed to load skills.";
  }

  // ROI is best-effort — the dashboard still renders skills if it fails.
  let valued: ReturnType<typeof valueRoi> | null = null;
  const valueSeries: number[] = [];
  const runsSeries: number[] = [];
  try {
    const [summary, daily] = await Promise.all([roiSummary(), roiDaily(30)]);
    valued = valueRoi(summary);
    let acc = 0;
    for (const d of daily) {
      acc += (d.minutesSaved / 60) * valued.rate - d.costUsd;
      valueSeries.push(Math.max(0, acc));
      runsSeries.push(d.runs);
    }
  } catch {
    /* leave ROI unshown */
  }

  return (
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-10">
      {/* Hero */}
      <section className="rise relative overflow-hidden py-10 md:py-16">
        <span className="chip">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--positive)] opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--positive)]" />
          </span>
          Hub online
        </span>

        <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight md:text-6xl">
          Your organization&apos;s <span className="text-gradient">expertise</span>,
          <br className="hidden sm:block" /> on tap.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-[var(--text-soft)]">
          Run captured expert workflows as one-click Skills — backed by your own
          data, tools, and security. Every run priced, so the value is never a guess.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/workbench" className="btn-brand">
            Skillify a workflow
          </Link>
          <Link href="/roi" className="chip glass-hover !px-4 !py-2.5">
            See the return on AI →
          </Link>
        </div>
      </section>

      {/* KPIs */}
      {valued && valued.overall.runs > 0 && (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Net value created"
            value={fmtUsd(valued.overall.netValueUsd)}
            accent="positive"
            series={valueSeries}
            seriesColor="var(--positive)"
          />
          <Kpi
            label="Analyst time saved"
            value={fmtHours(valued.overall.hoursSaved)}
          />
          <Kpi
            label="Skill runs"
            value={valued.overall.succeededRuns.toLocaleString()}
            series={runsSeries}
            seriesColor="var(--brand-2)"
          />
          <Kpi label="Active skills" value={skills.length.toLocaleString()} />
        </section>
      )}

      {/* Skills */}
      <section className="mt-14">
        <div className="mb-5 flex items-end justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Skills</h2>
          <Link href="/workbench" className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
            + Capture a new one
          </Link>
        </div>

        {skillsError ? (
          <div className="glass rounded-2xl p-5 text-sm text-[var(--warning)]">
            Couldn&apos;t load skills: {skillsError}
            <div className="mt-2 text-[var(--muted)]">
              Set <code>DATABASE_URL</code> and run{" "}
              <code>npm run migrate -w @ai-hub/db</code>.
            </div>
          </div>
        ) : skills.length === 0 ? (
          <div className="glass rounded-2xl p-8 text-center text-[var(--muted)]">
            No skills yet — capture your first workflow in the workbench.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((s, i) => (
              <Link
                key={s.id}
                href={`/skills/${s.slug}`}
                style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}
                className="glass sheen glass-hover rise group rounded-2xl p-5"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{s.name}</h3>
                  <span className="chip !px-2 !py-0.5 text-xs">
                    v{s.latestVersion ?? "—"}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">
                  {s.description || "No description."}
                </p>
                <span className="mt-5 inline-flex items-center gap-1 text-sm text-transparent brand-gradient bg-clip-text">
                  Open
                  <span className="text-[var(--brand)] transition-transform group-hover:translate-x-0.5">
                    →
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Kpi({
  label,
  value,
  series,
  seriesColor,
  accent,
}: {
  label: string;
  value: string;
  series?: number[];
  seriesColor?: string;
  accent?: "positive";
}) {
  return (
    <div className="glass sheen rise rounded-2xl p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div
        className={`mt-1.5 text-2xl font-semibold tracking-tight ${
          accent === "positive" ? "text-[var(--positive)]" : "text-[var(--text)]"
        }`}
      >
        {value}
      </div>
      {series && series.length > 1 && (
        <div className="mt-3 -mb-1">
          <Sparkline points={series} color={seriesColor} id={`spark-${label}`} />
        </div>
      )}
    </div>
  );
}
