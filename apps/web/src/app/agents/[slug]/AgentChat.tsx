"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendAgentMessageAction, type AgentChatMessage, type AgentTurnMeta } from "../actions";
import { Markdown } from "@/components/Markdown";

// Talking to the agent. Each answer carries what it cost and what it reached
// for, so a person can see the agent working rather than take it on trust.

type Turn = AgentChatMessage & { meta?: AgentTurnMeta };

const STARTERS = [
  "What do you remember about the work in flight?",
  "What are you able to do, and with which tools?",
  "What should I be worried about this week?",
];

export function AgentChat({ slug, name, enabled }: { slug: string; name: string; enabled: boolean }) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (turns.length) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns.length, sending]);

  function send(text = draft) {
    const content = text.trim();
    if (!content || sending) return;
    const next: Turn[] = [...turns, { role: "user", content }];
    setTurns(next);
    setDraft("");
    setError(null);
    start(async () => {
      const res = await sendAgentMessageAction(
        slug,
        next.map(({ role, content }) => ({ role, content })),
      );
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setTurns([...next, { role: "assistant", content: res.content, meta: res.meta }]);
      // The turn may have written a memory; pull the server state back in.
      router.refresh();
    });
  }

  if (!enabled) {
    return (
      <div className="panel notice-warning p-5 text-sm">
        {name} is switched off, so it cannot be talked to. Turn it on under{" "}
        <a href="#settings" className="underline">
          Settings
        </a>
        .
      </div>
    );
  }

  return (
    <div className="panel flex flex-col">
      <div className="flex min-h-[22rem] flex-col gap-5 p-5 md:p-6">
        {turns.length === 0 && (
          <div className="my-auto">
            <div className="eyebrow">New conversation</div>
            <p className="mt-2 max-w-xl text-[var(--text-soft)]">
              {name} starts with its brief and everything it has loaded into memory. Nothing said here is kept unless
              it decides to remember it.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="btn min-h-11 text-left">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="ml-auto max-w-[85%] bg-[var(--panel-inset)] px-4 py-3 text-sm">
              <div className="whitespace-pre-wrap">{t.content}</div>
            </div>
          ) : (
            <div key={i} className="group max-w-[92%]">
              <div className="mb-1.5 flex items-center gap-2 text-xs text-[var(--muted)]">
                <span aria-hidden className="inline-block h-2 w-2 bg-[var(--ai)]" />
                <span className="font-medium text-[var(--text)]">{name}</span>
                <CopyButton text={t.content} />
              </div>
              <Markdown className="border-l-2 border-[var(--ai)] pl-4">{t.content}</Markdown>
              {t.meta && <MetaLine meta={t.meta} />}
            </div>
          ),
        )}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-[var(--muted)]" role="status">
            <span aria-hidden className="ctx-blink inline-block h-2 w-2 bg-[var(--ai)]" />
            {name} is working…
          </div>
        )}
        {error && (
          <div role="alert" className="notice-danger border border-[var(--danger)] p-3 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
        <div ref={end} />
      </div>

      <form
        className="flex items-end gap-2 border-t border-[var(--border)] p-3 md:p-4"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          className="field min-h-12 flex-1 resize-y"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
          placeholder={`Ask ${name}…`}
          aria-label={`Message ${name}`}
        />
        <button type="submit" className="btn-brand min-h-12" disabled={sending || !draft.trim()}>
          Send
        </button>
      </form>
      {turns.length > 0 && (
        <div className="flex justify-between gap-3 px-4 pb-3 text-xs text-[var(--muted)]">
          <span>⌘/Ctrl + Enter to send</span>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => {
              setTurns([]);
              setError(null);
            }}
          >
            Start over
          </button>
        </div>
      )}
    </div>
  );
}

/** The answer as the agent wrote it, for pasting into a ticket or a mail. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ml-auto text-xs text-[var(--muted)] opacity-0 underline-offset-2 transition-opacity hover:text-[var(--brand)] hover:underline focus-visible:opacity-100 group-hover:opacity-100"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label="Copy this answer as Markdown"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function MetaLine({ meta }: { meta: AgentTurnMeta }) {
  const parts = [
    meta.model,
    `${(meta.latencyMs / 1000).toFixed(1)}s`,
    `$${meta.costUsd.toFixed(4)}`,
    meta.sources ? `${meta.sources} knowledge passage${meta.sources === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-xs text-[var(--muted)]">
      <span className="mono">{parts.join(" · ")}</span>
      {meta.toolsUsed.map((t) => (
        <span key={t} className="mono inline-flex items-center gap-1 border border-[var(--border-strong)] px-1.5 py-0.5">
          <span aria-hidden className="inline-block h-1.5 w-1.5 border" style={{ borderColor: "var(--c-src)" }} />
          {t}
        </span>
      ))}
    </div>
  );
}
