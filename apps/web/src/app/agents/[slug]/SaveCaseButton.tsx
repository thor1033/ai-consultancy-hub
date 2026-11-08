"use client";

import { useState } from "react";
import { saveCaseFromRunAction } from "../actions";

// "Save as a test case" on one of your own answers (docs/skill-tests.md):
// the exact request becomes a case on the skill, with no checks yet, and the
// person writes what should have happened under Tests.

export function SaveCaseButton({ runId }: { runId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  if (state === "saved") return <span>Saved as a test case · <a href="#skills" className="underline underline-offset-2">open its tests</a></span>;
  return (
    <button
      type="button"
      className="underline underline-offset-2 hover:text-[var(--brand-ink)] disabled:opacity-60"
      disabled={state === "busy"}
      onClick={async () => {
        setState("busy");
        const out = await saveCaseFromRunAction(runId);
        if ("error" in out) {
          setState("error");
          setMessage(out.error);
        } else setState("saved");
      }}
    >
      {state === "busy" ? "Saving…" : state === "error" ? `Could not save: ${message}` : "Save as a test case"}
    </button>
  );
}
