import Link from "next/link";
import {
  listSkills,
  roiSummary,
  roiDaily,
  listUpcomingSchedules,
  type ScheduleWithSkill,
} from "@ai-hub/db";
import { valueRoi, fmtUsd, fmtHours } from "@/lib/roi";
import { AreaTrend, Sparkline, RatioGauge } from "@/components/Charts";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

function shortDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function OverviewPage() {
  let skills: Awaited<ReturnType<typeof listSkills>> = [];
  let skillsError: string | null = null;
  try {
    skills = await listSkills();
  } catch (e) {
    skillsError = e instanceof Error ? e.message : "Failed to load skills.";
  }

  let valued: ReturnType<typeof valueRoi> | null = null;
  const trend: { label: string; value: number }[] = [];
  const runsSeries: number[] = [];
  const valueSeries: number[] = [];
  try {
    const [summary, daily] = await Promise.all([roiSummary(), roiDaily(30)]);
    valued = valueRoi(summary);
    let acc = 0;
    for (const d of daily) {
      acc += (d.minutesSaved / 60) * valued.rate - d.costUsd;
      valueSeries.push(Math.max(0, Math.round(acc)));
      runsSeries.push(d.runs);
      trend.push({ label: shortDate(d.day), value: Math.max(0, Math.round(acc)) });
    }
  } catch {
    /* ROI is best-effort */
  }

  let upcoming: ScheduleWithSkill[] = [];
  try {
    upcoming = await listUpcomingSchedules(6);
  } catch {
    /* best-effort */
  }

  const overall = valued?.overall;
  const hasRuns = !!overall && overall.runs > 0;
  const successRate = hasRuns ? (overall!.succeededRuns / overall!.runs) * 100 : 0;

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        title="Overview"
        subtitle="Live state of your organization's AI Skills — value, activity, and inventory."
        actions={<span className="chip">Last 30 days</span>}
      />

      {/* KPI strip */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Net value created"
          value={hasRuns ? fmtUsd(overall!.netValueUsd) : "—"}
          accent="positive"
          series={hasRuns ? valueSeries : undefined}
          seriesColor="var(--positive)"
        />
        <Stat
          label="Analyst time saved"
          value={hasRuns ? fmtHours(overall!.hoursSaved) : "—"}
        />
        <Stat
          label="Skill runs"
          value={hasRuns ? overall!.succeededRuns.toLocaleString() : "0"}
          series={hasRuns ? runsSeries : undefined}
          seriesColor="var(--brand-2)"
        />
        <Stat label="Active skills" value={skills.length.toLocaleString()} />
      </section>

      {/* Activity + gauge */}
      {hasRuns && (
        <section className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="panel fade-in p-5 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-[var(--text-soft)]">
                Value created
              </h2>
              <span className="text-xs text-[var(--muted)]">cumulative, 30d</span>
            </div>
            <AreaTrend points={trend} format="usd" height={220} />
          </div>
          <div className="panel fade-in p-5">
            <h2 className="mb-1 text-sm font-medium text-[var(--text-soft)]">
              Run reliability
            </h2>
            <RatioGauge
              percent={successRate}
              center={`${Math.round(successRate)}%`}
              label="succeeded"
              height={168}
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Mini label="AI spend" value={fmtUsd(overall!.aiSpendUsd)} />
              <Mini
                label="Return"
                value={
                  overall!.aiSpendUsd > 0
                    ? `${Math.round(overall!.laborValueUsd / overall!.aiSpendUsd).toLocaleString()}×`
                    : "∞"
                }
                accent
              />
            </div>
          </div>
        </section>
      )}

      {/* Scheduled automations */}
      {upcoming.length > 0 && (
        <section className="mt-3">
          <div className="panel fade-in overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5">
              <h2 className="text-sm font-medium text-[var(--text-soft)]">
                Scheduled automations
              </h2>
              <span className="text-xs text-[var(--muted)]">next {upcoming.length}</span>
            </div>
            <ul>
              {upcoming.map((s) => (
                <li key={s.id} className="hairline">
                  <Link
                    href={`/skills/${s.skillSlug}`}
                    className="group flex items-center gap-4 px-5 py-3 transition hover:bg-[var(--panel-2)]"
                  >
                    <span className="flex items-center gap-2 text-[var(--brand-ink)]" aria-hidden>
                      <ClockIcon />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{s.skillName}</div>
                      <div className="mono truncate text-xs text-[var(--muted)]">
                        {cadence(s)}
                      </div>
                    </div>
                    <span className="mono shrink-0 text-xs text-[var(--text-soft)]">
                      {whenLabel(s.nextRunAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Skills inventory */}
      <section className="mt-3">
        <div className="panel fade-in overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5">
            <h2 className="text-sm font-medium text-[var(--text-soft)]">
              Skills{" "}
              <span className="ml-1 text-[var(--muted)]">{skills.length}</span>
            </h2>
            <Link
              href="/workbench"
              className="text-xs text-[var(--muted)] transition hover:text-[var(--text)]"
            >
              + Capture new
            </Link>
          </div>

          {skillsError ? (
            <div className="hairline px-5 py-4 text-sm text-[var(--warning)]">
              Couldn&apos;t load skills: {skillsError}. Set <code>DATABASE_URL</code> and
              run <code>npm run migrate -w @ai-hub/db</code>.
            </div>
          ) : skills.length === 0 ? (
            <div className="hairline px-5 py-10 text-center text-sm text-[var(--muted)]">
              No skills yet — capture your first workflow in the workbench.
            </div>
          ) : (
            <ul>
              {skills.map((sk) => (
                <li key={sk.id} className="hairline">
                  <Link
                    href={`/skills/${sk.slug}`}
                    className="group flex items-center gap-4 px-5 py-3.5 transition hover:bg-[var(--panel-2)]"
                  >
                    <span className="dot text-[var(--positive)] bg-[var(--positive)]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{sk.name}</span>
                        <span className="mono rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.68rem] text-[var(--muted)]">
                          v{sk.latestVersion ?? "—"}
                        </span>
                      </div>
                      <p className="truncate text-xs text-[var(--muted)]">
                        {sk.description || "No description."}
                      </p>
                    </div>
                    <span className="text-sm text-[var(--muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--brand-ink)]">
                      Open →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cadence(s: ScheduleWithSkill): string {
  switch (s.kind) {
    case "once":
      return "Once";
    case "daily":
      return `Every day at ${s.timeOfDay}`;
    case "weekly":
      return `Every ${WEEKDAYS[s.weekday ?? 1]} at ${s.timeOfDay}`;
    case "monthly":
      return `Monthly, day ${s.dayOfMonth ?? 1} at ${s.timeOfDay}`;
    default:
      return s.kind;
  }
}

function whenLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.toDateString() === now.toDateString()
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return d.toLocaleString(undefined, opts);
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function Stat({
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
    <div className="panel fade-in p-4">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div
        className={`metric mt-1 text-2xl font-semibold ${
          accent === "positive" ? "text-[var(--positive)]" : "text-[var(--text)]"
        }`}
      >
        {value}
      </div>
      {series && series.length > 1 ? (
        <div className="mt-2 -mb-1 h-9">
          <Sparkline points={series} color={seriesColor} height={36} id={`sp-${label}`} />
        </div>
      ) : (
        <div className="mt-2 h-9" />
      )}
    </div>
  );
}

function Mini({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="inset px-3 py-2">
      <div className="text-[0.68rem] uppercase tracking-wide text-[var(--muted)]">
        {label}
      </div>
      <div className={`metric mt-0.5 text-sm font-semibold ${accent ? "text-[var(--brand-ink)]" : ""}`}>
        {value}
      </div>
    </div>
  );
}
