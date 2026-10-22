"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/*
 * Agent output, rendered. Agents write Markdown because the model is asked to
 * be scannable (headings, tables, lists); shown raw it is the opposite. The
 * styles live under `.md` in globals.css and follow the product rules:
 * headings inside an answer are small labels, not display type; tables are
 * hairlines; nothing is rounded.
 *
 * The text is the model's and so untrusted: react-markdown escapes inline HTML
 * by default and no raw-HTML plugin is added. Links open in a new tab without a
 * referrer, and only http(s)/mailto are allowed as hrefs (the default
 * `urlTransform` already drops javascript: and data: URLs).
 */
export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`md ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          ),
          // Wide tables scroll inside the answer instead of breaking the page.
          table: ({ children: rows }) => (
            <div className="md-table">
              <table>{rows}</table>
            </div>
          ),
          // A model never needs to render a form control.
          input: ({ checked }) => (
            <span aria-hidden className="md-check" data-checked={checked ? "true" : "false"} />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
