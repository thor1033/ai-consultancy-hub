import Link from "next/link";
import { roiSummary, roiDaily } from "@ai-hub/db";
import { valueRoi, fmtUsd, fmtHours } from "@/lib/roi";
import { AreaTrend, SkillBars, RatioGauge } from "@/components/Charts";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

function shortDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function RoiPage() {
  let data: ReturnType<typeof valueRoi> | null = null;
  let trend: { label: string; value: number }[] = [];
  let error: string | null = null;
  try {
    const [summary, daily] = await Promise.all([roiSummary(), roiDaily(30)]);
    data = valueRoi(summary);
    let acc = 0;
    trend = daily.map((d) => {
      acc += (d.minutesSaved / 60) * data!.rate - d.costUsd;
      return { label: shortDate(d.day), value: Math.max(0, Math.round(acc)) };
    });
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load ROI.";
  }

  const overall = data?.overall;
  const successRate =
    overall && overall.runs > 0 ? (overall.succeededRuns / overall.runs) * 100 : 0;
  const multiple =
    overall && overall.aiSpendUsd > 0 ? overall.laborValueUsd / overall.aiSpendUsd : null;
  const bars =
    data?.bySkill
      .filter((s) => s.netValueUsd > 0)
      .slice(0, 8)
      .map((s) => ({ name: s.name, value: Math.round(s.netValueUsd) })) ?? [];

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Return on AI"
        title="Money & time saved"
        subtitle={`Analyst time your Skills replaced, priced at ${fmtUsd(data?.rate ?? 0)}/hr — straight from real runs.`}
        actions={<span className="chip">Last 30 days</span>}
      />

      {error ? (
        <div className="panel p-5 text-sm text-[var(--warning)]">
          Couldn&apos;t load ROI: {error}
        </div>
      ) : !overall || overall.runs === 0 ? (
        <div className="panel p-10 text-center text-sm text-[var(--muted)]">
          No runs recorded yet. Run a Skill and its ROI shows up here.
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Net value created" value={fmtUsd(overall.netValueUsd)} accent="positive" />
            <Stat label="Analyst time saved" value={fmtHours(overall.hoursSaved)} />
            <Stat label="AI spend" value={fmtUsd(overall.aiSpendUsd)} />
            <Stat
              label="Return multiple"
              value={multiple ? `${Math.round(multiple).toLocaleString()}×` : "∞"}
              accent="brand"
            />
          </section>

          <section className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="panel fade-in p-5 lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium text-[var(--text-soft)]">
                  Cumulative value created
                </h2>
                <span className="metric text-sm font-semibold text-[var(--positive)]">
                  {fmtUsd(overall.netValueUsd)}
                </span>
              </div>
              <AreaTrend points={trend} format="usd" height={240} color="var(--positive)" />
            </div>
            <div className="panel fade-in p-5">
              <h2 className="mb-1 text-sm font-medium text-[var(--text-soft)]">
                Run reliability
              </h2>
              <RatioGauge
                percent={successRate}
                center={`${Math.round(successRate)}%`}
                label="succeeded"
                height={176}
              />
              <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                <Mini label="Runs" value={overall.succeededRuns.toLocaleString()} />
                <Mini label="Labor value" value={fmtUsd(overall.laborValueUsd)} />
              </div>
            </div>
          </section>

          <section className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="panel fade-in p-5">
              <h2 className="mb-4 text-sm font-medium text-[var(--text-soft)]">
                Net value by skill
              </h2>
              {bars.length > 0 ? (
                <SkillBars data={bars} format="usd" height={Math.max(150, bars.length * 40)} />
              ) : (
                <p className="text-sm text-[var(--muted)]">No positive-value skills yet.</p>
              )}
            </div>

            <div className="panel fade-in overflow-hidden">
              <h2 className="px-5 py-3.5 text-sm font-medium text-[var(--text-soft)]">
                Breakdown
              </h2>
              <div>
                <div className="hairline grid grid-cols-[1fr_auto_auto] gap-4 px-5 py-2 text-[0.68rem] uppercase tracking-wide text-[var(--muted)]">
                  <span>Skill</span>
                  <span className="text-right">Time saved</span>
                  <span className="text-right">Net value</span>
                </div>
                {data!.bySkill.map((s) => (
                  <div
                    key={s.slug}
                    className="hairline grid grid-cols-[1fr_auto_auto] items-center gap-4 px-5 py-3"
                  >
                    <Link href={`/skills/${s.slug}`} className="truncate font-medium hover:text-[var(--brand-ink)]">
                      {s.name}
                      {s.runs !== s.succeededRuns && (
                        <span className="ml-2 text-xs text-[var(--warning)]">
                          {s.runs - s.succeededRuns} failed
                        </span>
                      )}
                    </Link>
                    <span className="metric text-right text-sm text-[var(--muted)]">
                      {fmtHours(s.hoursSaved)}
                    </span>
                    <span className="metric text-right text-sm font-semibold text-[var(--positive)]">
                      {fmtUsd(s.netValueUsd)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <p className="mt-4 text-xs text-[var(--muted)]">
            Time saved credits each run with its skill version&apos;s manual baseline; only
            succeeded runs count. Set <code>ANALYST_HOURLY_RATE</code> to price it per client.
          </p>
        </>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "positive" | "brand";
}) {
  const color =
    accent === "positive"
      ? "text-[var(--positive)]"
      : accent === "brand"
        ? "text-[var(--brand-ink)]"
        : "text-[var(--text)]";
  return (
    <div className="panel fade-in p-4">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`metric mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="inset px-3 py-2">
      <div className="text-[0.68rem] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="metric mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}
