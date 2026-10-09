"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Issue #979 — a requirement's body, rendered as Markdown.
 *
 * Bodies are Markdown by construction: synthesis writes headings and lists, and
 * the clarification pass (#1116) appends a "## Clarifications" block wrapped in
 * `<!-- metis:clarifications:start -->` / `:end -->` markers so re-runs replace
 * rather than stack. Shown as plain text, the walkthrough saw raw `##`, `**Q:**`
 * and both marker comments.
 *
 * Safety: `skipHtml` drops every raw HTML node, so nothing in a body (which can
 * carry imported or user-authored text) becomes markup; react-markdown's default
 * URL transform already neutralises `javascript:` and similar link schemes. The
 * markers are removed explicitly as well, so they cannot surface as text even if
 * they are malformed enough not to parse as an HTML comment.
 */

const CLARIFICATION_MARKER = /<!--\s*metis:clarifications:(?:start|end)\s*-->/g;

/** The body with METIS's internal block markers removed. */
export function stripInternalMarkers(body: string): string {
  return body.replace(CLARIFICATION_MARKER, "").trim();
}

export function RequirementBody({ body }: { body: string | null | undefined }) {
  const text = stripInternalMarkers(body ?? "");
  if (!text) return null;
  return (
    <div
      data-testid="requirement-body"
      className="prose prose-sm dark:prose-invert mt-1 max-w-prose text-sm leading-relaxed text-foreground prose-headings:mb-1 prose-headings:mt-3 prose-headings:text-sm prose-headings:text-foreground prose-p:my-1 prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-ul:my-1 prose-code:before:content-none prose-code:after:content-none"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
