export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6">
      <div className="flex items-center gap-3">
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <span className="text-sm text-neutral-400">Hub online</span>
      </div>

      <h1 className="text-5xl font-semibold tracking-tight">AI Hub</h1>

      <p className="text-lg leading-relaxed text-neutral-400">
        Your tailored AI hub. Run your organization&apos;s Skills and Agents — backed by
        your own data, context, and security — on the AI licenses you already pay for.
      </p>

      <div className="text-sm text-neutral-500">
        MVP scaffold · Thing 1 of 7 (repo skeleton) complete
      </div>
    </main>
  );
}
