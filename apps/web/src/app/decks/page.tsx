import Link from "next/link";
import { knowledgeAccessFor } from "@ai-hub/authz";
import { listCollections } from "@ai-hub/rag";
import type { Deck } from "@ai-hub/db";
import { PageHeader } from "@/components/PageHeader";
import { sessionCan } from "@/lib/sessionPrincipal";
import { visibleDecks } from "@/lib/decks/ops";
import { rel } from "@/lib/format";
import { NewDeck } from "./NewDeck";
import { viewContext } from "@/lib/viewServer";

export const dynamic = "force-dynamic";

/*
 * Decks: presentations the hub draws and that can change while they are on
 * screen. Built here or from Claude Code (hub_deck_* tools), presented from
 * the presenter view, exported to PDF at the end.
 */
export default async function DecksPage() {
  const principal = await sessionCan("agent:run");
  const { view } = await viewContext();
  if (!principal) {
    return (
      <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
        <PageHeader eyebrow="Decks" title="Decks" />
        <div className="panel notice-warning p-4 text-sm text-[var(--warning)]">Your role does not include decks.</div>
      </main>
    );
  }

  let decks: Deck[] = [];
  let collections: string[] = [];
  let error: string | null = null;
  try {
    [decks, collections] = await Promise.all([visibleDecks(principal), knowledgeAccessFor(principal).then(listCollections)]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load the decks.";
  }
  const now = Date.now();

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-7 lg:px-8">
      <PageHeader
        eyebrow="Decks"
        title="Decks"
        subtitle="Presentations that change while you present. Questions from the room become slides in your tray; you decide what goes on screen."
      />
      {error && <div className="panel notice-warning mb-6 p-4 text-sm text-[var(--warning)]">{error}</div>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="panel">
          {decks.length === 0 ? (
            <p className="p-6 text-sm text-[var(--text-soft)]">
              {view === "expert" ? (
                <>
                  No decks yet. Make one here, or from Claude Code: ask it to build a deck with the hub&apos;s
                  <span className="mono"> hub_deck_create</span> tool.
                </>
              ) : (
                "No decks yet. Make one here: give it a title and say what it is about, and an agent drafts the slides."
              )}
            </p>
          ) : (
            <ul>
              {decks.map((d) => {
                const live = d.slides.filter((s) => s.status === "live").length;
                const waiting = d.slides.length - live;
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--border)] px-5 py-4 first:border-t-0">
                    <div className="min-w-0 flex-1">
                      <Link href={`/decks/${d.id}`} className="font-medium underline-offset-2 hover:text-[var(--brand)] hover:underline">
                        {d.title}
                      </Link>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {live} slide{live === 1 ? "" : "s"}
                        {waiting > 0 && <span className="text-[var(--ai)]"> · {waiting} in the tray</span>}
                        {d.collection && (
                          <>
                            {" · "}
                            <span className="mono">{d.collection}</span>
                          </>
                        )}
                        {" · updated "}
                        {rel(d.updatedAt, now).toLowerCase()}
                      </p>
                    </div>
                    {d.presenting && (
                      <span className="flex items-center gap-1.5 text-xs text-[var(--brand)]">
                        <span aria-hidden className="ctx-blink inline-block h-2 w-2 bg-[var(--brand)]" />
                        Presenting
                      </span>
                    )}
                    <Link href={`/decks/${d.id}/present`} className="btn min-h-9 text-xs">
                      Present
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <aside className="panel p-5">
          <NewDeck collections={collections} />
        </aside>
      </div>
    </main>
  );
}
