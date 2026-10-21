"use client";

import { useState } from "react";

// One line of text worth copying — a URL or a command — with a button that
// says when it worked. The text stays selectable for browsers that refuse the
// clipboard API (an insecure origin, a locked-down profile).
export function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code className="inset mono min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap px-3 py-2.5 text-xs">
        {text}
      </code>
      <button
        type="button"
        className="btn min-h-10 shrink-0"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
