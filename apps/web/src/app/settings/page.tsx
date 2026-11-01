import { VIEWS, VIEW_INFO } from "@/lib/views";
import { viewContext } from "@/lib/viewServer";
import { ViewChooser } from "./ViewChooser";
import { StewardConsent } from "./StewardConsent";
import { getPrincipal, retentionPolicy } from "@ai-hub/db";

export const dynamic = "force-dynamic";

// How the hub looks to you (docs/views.md). Three views of the same hub: the
// choice hides and shows, it never grants — what you may do is your role's.

export default async function SettingsPage() {
  const { view, from, saves, principal } = await viewContext();
  // Read fresh from the row: it is the steward's source of truth too.
  const stewardAllowed = principal ? (await getPrincipal(principal.id).catch(() => null))?.preferences?.stewardMayRead === true : false;
  const fromText =
    from === "you"
      ? saves
        ? "You chose it. It is saved to your account, so it follows you to other devices."
        : "You chose it, on this browser."
      : from === "deployment"
        ? "It is this hub's default for everyone, until you choose."
        : "It is the default for your role, until you choose.";
  return (
    <main className="mx-auto max-w-[70rem] px-5 py-7 lg:px-8">
      <header>
        <div className="eyebrow">Settings</div>
        <h1 className="mt-3 text-3xl md:text-4xl">How the hub looks to you.</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          The hub is the same underneath for everyone. Choose how much of it you see: switch any time, nothing is lost, and it never changes what
          you are allowed to do.
        </p>
      </header>
      <ViewChooser
        current={view}
        canReset={from === "you"}
        fromText={fromText}
        views={VIEWS.map((v) => ({ id: v, ...VIEW_INFO[v] }))}
        signedIn={Boolean(principal)}
      />
      {saves && (
        <div className="mt-6">
          <StewardConsent allowed={stewardAllowed} />
        </div>
      )}
      {principal && <YourData />}
    </main>
  );
}

/** What the hub keeps about you and for how long, and a copy of it (docs/retention.md). */
function YourData() {
  const p = retentionPolicy();
  return (
    <section className="panel mt-6 p-5 md:p-6">
      <div className="eyebrow">Your data</div>
      <p className="mt-2 max-w-2xl text-sm text-[var(--text-soft)]">
        What you ask the agents and what they answer is kept for {p.answersDays} days, so you can find it again under &ldquo;Your
        answers&rdquo;. The full record of a conversation — everything its tools read — is kept for {p.transcriptsDays} days. After that
        only the numbers stay: which agent, how long, how much. Memories and documents stay until someone removes them.
      </p>
      <a className="btn mt-4 inline-flex min-h-11" href="/settings/export">
        Download everything about you
      </a>
      <p className="mt-2 text-xs text-[var(--muted)]">
        To have your data erased, ask an admin of this hub; they can do it from the Admin page.
      </p>
    </section>
  );
}
