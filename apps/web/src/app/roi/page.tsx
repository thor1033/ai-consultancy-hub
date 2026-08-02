import Link from "next/link";
import { roiSummary } from "@ai-hub/db";
import { valueRoi, fmtUsd, fmtHours } from "@/lib/roi";

// Reads the DB at request time — never prerender at build.
export const dynamic = "force-dynamic";

export default async function RoiPage() {
  let data: ReturnType<typeof valueRoi> | null = null;
  let error: string | null = null;
  try {
    data = valueRoi(await roiSummary());
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load ROI.";
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Skills
      </Link>

      <header className="mt-6 mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Return on AI</h1>
        <p className="mt-1 text-neutral-400">
          Analyst time your Skills have replaced, priced at{" "}
          <span className="text-neutral-300">{fmtUsd(data?.rate ?? 0)}/hr</span> —
          the money-saved number, straight from real runs.
        </p>
      </header>

      {error ? (
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-300">
          Couldn&apos;t load ROI: {error}
        </div>
      ) : !data || data.overall.runs === 0 ? (
        <p className="text-neutral-500">
          No runs recorded yet. Run a Skill and its ROI will show up here.
        </p>
      ) : (
        <>
          {/* The headline: net value created. */}
          <div className="grid gap-4 sm:grid-cols-4">
            <Big
              label="Net value created"
              value={fmtUsd(data.overall.netValueUsd)}
            />
            <Big label="Analyst time saved" value={fmtHours(data.overall.hoursSaved)} />
            <Big label="AI spend" value={fmtUsd(data.overall.aiSpendUsd)} muted />
            <Big
              label="Skill runs"
              value={data.overall.succeededRuns.toLocaleString()}
              muted
            />
          </div>

          <p className="mt-4 text-sm text-neutral-500">
            {fmtHours(data.overall.hoursSaved)} of expert work ×{" "}
            {fmtUsd(data.rate)}/hr ={" "}
            <span className="text-neutral-300">
              {fmtUsd(data.overall.laborValueUsd)}
            </span>{" "}
            in labor value, delivered for {fmtUsd(data.overall.aiSpendUsd)} of AI —
            a{" "}
            <span className="text-emerald-400">
              {data.overall.aiSpendUsd > 0
                ? `${Math.round(
                    data.overall.laborValueUsd / data.overall.aiSpendUsd,
                  ).toLocaleString()}×`
                : "∞"}
            </span>{" "}
            return.
          </p>

          {/* Per-skill breakdown. */}
          <section className="mt-10">
            <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
              By skill
            </h2>
            <div className="overflow-hidden rounded-lg border border-neutral-800">
              <table className="w-full text-sm">
                <thead className="bg-neutral-900/60 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <Th>Skill</Th>
                    <Th right>Runs</Th>
                    <Th right>Time saved</Th>
                    <Th right>AI spend</Th>
                    <Th right>Net value</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800">
                  {data.bySkill.map((s) => (
                    <tr key={s.slug} className="hover:bg-neutral-900/40">
                      <Td>
                        <Link
                          href={`/skills/${s.slug}`}
                          className="font-medium text-neutral-100 hover:text-emerald-400"
                        >
                          {s.name}
                        </Link>
                        {s.runs !== s.succeededRuns && (
                          <span className="ml-2 text-xs text-amber-400/80">
                            {s.runs - s.succeededRuns} failed
                          </span>
                        )}
                      </Td>
                      <Td right>{s.succeededRuns.toLocaleString()}</Td>
                      <Td right>{fmtHours(s.hoursSaved)}</Td>
                      <Td right className="text-neutral-400">
                        {fmtUsd(s.costUsd)}
                      </Td>
                      <Td right className="font-medium text-emerald-400">
                        {fmtUsd(s.netValueUsd)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-neutral-600">
              Time saved credits each run with its skill version&apos;s manual
              baseline; only succeeded runs count. Set{" "}
              <code>ANALYST_HOURLY_RATE</code> to price it per client.
            </p>
          </section>
        </>
      )}
    </main>
  );
}

function Big({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold ${
          muted ? "text-neutral-100" : "text-emerald-400"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-4 py-2.5 font-medium ${right ? "text-right" : ""}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  className = "",
}: {
  children: React.ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-4 py-3 ${right ? "text-right tabular-nums" : ""} ${className}`}>
      {children}
    </td>
  );
}
