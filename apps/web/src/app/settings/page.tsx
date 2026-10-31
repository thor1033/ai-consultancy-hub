import { VIEWS, VIEW_INFO } from "@/lib/views";
import { viewContext } from "@/lib/viewServer";
import { ViewChooser } from "./ViewChooser";

export const dynamic = "force-dynamic";

// How the hub looks to you (docs/views.md). Three views of the same hub: the
// choice hides and shows, it never grants — what you may do is your role's.

export default async function SettingsPage() {
  const { view, from, saves, principal } = await viewContext();
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
    </main>
  );
}
