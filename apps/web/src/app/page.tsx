import Link from "next/link";
import { listSkills } from "@ai-hub/db";

// Reads the DB at request time — never prerender at build.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let skills: Awaited<ReturnType<typeof listSkills>> = [];
  let error: string | null = null;
  try {
    skills = await listSkills();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load skills.";
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-neutral-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400" /> Hub online
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/assessment"
              className="rounded-full border border-neutral-700 px-3 py-1 text-sm text-neutral-300 transition hover:border-emerald-500/50 hover:text-emerald-400"
            >
              Readiness assessment
            </Link>
            <Link
              href="/workbench"
              className="rounded-full border border-neutral-700 px-3 py-1 text-sm text-neutral-300 transition hover:border-emerald-500/50 hover:text-emerald-400"
            >
              + Skillify a workflow
            </Link>
            <Link
              href="/roi"
              className="rounded-full border border-neutral-700 px-3 py-1 text-sm text-neutral-300 transition hover:border-emerald-500/50 hover:text-emerald-400"
            >
              Return on AI →
            </Link>
            <Link
              href="/admin"
              className="rounded-full border border-neutral-700 px-3 py-1 text-sm text-neutral-300 transition hover:border-emerald-500/50 hover:text-emerald-400"
            >
              Control plane
            </Link>
          </div>
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">AI Hub</h1>
        <p className="mt-1 text-neutral-400">
          Run your organization&apos;s Skills — backed by your own data, context, and security.
        </p>
      </header>

      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
          Skills
        </h2>

        {error ? (
          <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-300">
            Couldn&apos;t load skills: {error}
            <div className="mt-2 text-amber-400/80">
              Set <code>DATABASE_URL</code> and run{" "}
              <code>npm run migrate -w @ai-hub/db</code>.
            </div>
          </div>
        ) : skills.length === 0 ? (
          <p className="text-neutral-500">No skills yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {skills.map((s) => (
              <Link
                key={s.id}
                href={`/skills/${s.slug}`}
                className="group rounded-lg border border-neutral-800 bg-neutral-900/40 p-5 transition hover:border-neutral-700 hover:bg-neutral-900"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{s.name}</h3>
                  <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
                    v{s.latestVersion ?? "—"}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-neutral-400">
                  {s.description || "No description."}
                </p>
                <span className="mt-4 inline-block text-sm text-emerald-400 group-hover:underline">
                  Open →
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
