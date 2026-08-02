import Link from "next/link";
import { roiSummary, roiDaily } from "@ai-hub/db";
import { valueRoi, fmtUsd, fmtHours } from "@/lib/roi";
import { AreaTrend, SkillBars, RatioGauge } from "@/components/Charts";

export const dynamic = "force-dynamic";

function shortDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
    overall && overall.aiSpendUsd > 0
      ? overall.laborValueUsd / overall.aiSpendUsd
      : null;

  const bars =
    data?.bySkill
      .filter((s) => s.netValueUsd > 0)
      .slice(0, 8)
      .map((s) => ({ name: s.name, value: Math.round(s.netValueUsd) })) ?? [];

  return (
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-10">
      <header className="rise mb-10">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Return on <span className="text-gradient">AI</span>
        </h1>
        <p className="mt-2 max-w-2xl text-[var(--text-soft)]">
          Analyst time your Skills have replaced, priced at{" "}
          <span className="text-[var(--text)]">{fmtUsd(data?.rate ?? 0)}/hr</span> — the
          money-saved number, straight from real runs.
        </p>
      </header>

      {error ? (
        <div className="glass rounded-2xl p-5 text-sm text-[var(--warning)]">
          Couldn&apos;t load ROI: {error}
        </div>
      ) : !overall || overall.runs === 0 ? (
        <div className="glass rounded-2xl p-8 text-center text-[var(--muted)]">
          No runs recorded yet. Run a Skill and its ROI shows up here.
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Hero trend */}
            <div className="glass sheen rise rounded-3xl p-6 lg:col-span-2">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
                    Net value created
                  </div>
                  <div className="mt-1 text-4xl font-semibold tracking-tight text-[var(--positive)]">
                    {fmtUsd(overall.netValueUsd)}
                  </div>
                </div>
                <span className="chip">last 30 days</span>
              </div>
              <div className="mt-4">
                <AreaTrend points={trend} format="usd" height={240} />
              </div>
            </div>

            {/* Side: gauge + headline stats */}
            <div className="glass sheen rise rounded-3xl p-6">
              <RatioGauge
                percent={successRate}
                center={`${Math.round(successRate)}%`}
                label="Run success"
                height={190}
              />
              <div className="mt-4 grid grid-cols-2 gap-3">
                <MiniStat
                  label="Return"
                  value={multiple ? `${Math.round(multiple).toLocaleString()}×` : "∞"}
                  accent
                />
                <MiniStat label="AI spend" value={fmtUsd(overall.aiSpendUsd)} />
              </div>
            </div>
          </div>

          {/* KPI row */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Analyst time saved" value={fmtHours(overall.hoursSaved)} />
            <Kpi label="Labor value" value={fmtUsd(overall.laborValueUsd)} accent />
            <Kpi label="AI spend" value={fmtUsd(overall.aiSpendUsd)} />
            <Kpi label="Skill runs" value={overall.succeededRuns.toLocaleString()} />
          </div>

          {/* By skill */}
          <section className="mt-10 grid gap-4 lg:grid-cols-2">
            <div className="glass sheen rounded-3xl p-6">
              <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Net value by skill
              </h2>
              {bars.length > 0 ? (
                <SkillBars data={bars} format="usd" height={Math.max(160, bars.length * 42)} />
              ) : (
                <p className="text-sm text-[var(--muted)]">No positive-value skills yet.</p>
              )}
            </div>

            <div className="glass sheen rounded-3xl p-6">
              <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
                Breakdown
              </h2>
              <div className="divide-y divide-[var(--border)]">
                {data!.bySkill.map((s) => (
                  <div key={s.slug} className="flex items-center justify-between py-3">
                    <Link
                      href={`/skills/${s.slug}`}
                      className="font-medium hover:text-[var(--brand)]"
                    >
                      {s.name}
                      {s.runs !== s.succeededRuns && (
                        <span className="ml-2 text-xs text-[var(--warning)]">
                          {s.runs - s.succeededRuns} failed
                        </span>
                      )}
                    </Link>
                    <div className="flex items-center gap-4 text-sm tabular-nums">
                      <span className="text-[var(--muted)]">{fmtHours(s.hoursSaved)}</span>
                      <span className="font-medium text-[var(--positive)]">
                        {fmtUsd(s.netValueUsd)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <p className="mt-6 text-xs text-[var(--muted)]">
            Time saved credits each run with its skill version&apos;s manual baseline;
            only succeeded runs count. Set <code>ANALYST_HOURLY_RATE</code> to price it
            per client.
          </p>
        </>
      )}
    </main>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="glass sheen rounded-2xl p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div
        className={`mt-1.5 text-2xl font-semibold tracking-tight ${
          accent ? "text-[var(--positive)]" : "text-[var(--text)]"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="text-[0.7rem] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${accent ? "text-[var(--brand)]" : "text-[var(--text)]"}`}>
        {value}
      </div>
    </div>
  );
}
