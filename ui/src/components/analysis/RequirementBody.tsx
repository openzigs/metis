"use client";

import { createElement, useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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
 *
 * No image is ever loaded (#998): a body can be imported issue text, and
 * `![x](https://host/pixel.png)` would make every viewer's browser fetch a URL
 * its author chose, a tracking beacon on the Requirements tab, a baseline, a gap
 * report and a review. A Markdown image renders as its alt text, linked to the
 * address when that is an absolute http(s) URL, so following it is the reader's
 * choice; a relative or scheme-less address is text only.
 */

/**
 * Every METIS block marker, not only the clarification pair: the criteria flag
 * (`<!-- metis:criteria-predate-answers -->`, #1116) is written inline too (#998).
 */
const INTERNAL_MARKER = /<!--\s*metis:[\w:-]+\s*-->/g;

/** The body with METIS's internal block markers removed. */
export function stripInternalMarkers(body: string): string {
  return body.replace(INTERNAL_MARKER, "").trim();
}

/** A Markdown image, as text: never an `<img>`, so nothing is fetched on view. */
function ImageAsText({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const label = alt?.trim() || "image";
  if (typeof src === "string" && /^https?:\/\//i.test(src)) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer nofollow"
        data-testid="body-image-link"
      >
        {label}
      </a>
    );
  }
  return <span data-testid="body-image-text">{label}</span>;
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

/**
 * Renderers that keep a body's headings at `minLevel` or deeper, so a body shown
 * under a card's own `h5` title cannot put an `h2` beneath it.
 */
function headingComponents(minLevel: HeadingLevel): Components {
  const out: Components = {};
  for (const level of HEADING_LEVELS) {
    if (level >= minLevel) continue;
    out[`h${level}`] = ({ children }) => createElement(`h${minLevel}`, null, children);
  }
  return out;
}

export function RequirementBody({
  body,
  minHeadingLevel = 1,
}: {
  body: string | null | undefined;
  /**
   * The shallowest heading the body may render: pass the level just below the
   * surrounding title's. Shallower Markdown headings are rendered at this level.
   */
  minHeadingLevel?: HeadingLevel;
}) {
  const components = useMemo<Components>(
    () => ({ img: ImageAsText, ...headingComponents(minHeadingLevel) }),
    [minHeadingLevel],
  );
  const text = stripInternalMarkers(body ?? "");
  if (!text) return null;
  return (
    <div
      data-testid="requirement-body"
      className="prose prose-sm dark:prose-invert mt-1 max-w-prose break-words text-sm leading-relaxed text-foreground prose-headings:mb-1 prose-headings:mt-3 prose-headings:text-sm prose-headings:text-foreground prose-p:my-1 prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-ul:my-1 prose-code:before:content-none prose-code:after:content-none"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
