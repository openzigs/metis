/**
 * Issue #985 (#3) — render untrusted LLM narrative text (the impact-summarizer
 * output) with `` `backtick` `` spans as inline code, WITHOUT ever parsing HTML.
 *
 * The impact summarizer emits lightweight markdown (backticked identifiers like
 * `` `orders` ``), but the run-level and per-item narratives were rendered as a
 * plain string, so the backticks showed up literally instead of as inline code.
 *
 * This is deliberately NOT a markdown renderer. It only recognizes backtick
 * spans and returns React nodes: text outside a span is a plain string (React
 * always renders string children as escaped text, never as markup), and text
 * inside a span becomes the text child of a literal `<code>` element. No HTML
 * is ever parsed and `dangerouslySetInnerHTML` is never used, so injecting
 * `<img src=x onerror=...>` — inside or outside backticks — is structurally
 * inert: it can only ever become a text node.
 */
import type { ReactNode } from "react";

const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;

/**
 * Tokenize `text` into a mix of plain strings and `<code>` React elements.
 * Malformed input degrades safely — an unmatched or empty backtick pair is
 * left as literal text — and every character survives somewhere in the
 * output (never throws, never silently drops content). That does NOT mean
 * pairing is left-to-right/non-greedy: with 3+ backtick runs (e.g.
 * `` `a `b` c` ``) the regex still re-pairs adjacent backticks into a `<code>`
 * span, which can read as a different grouping than a naive first-pair match
 * would suggest, even though no text is lost.
 */
export function renderInlineCode(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE_CODE_PATTERN);
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <code
        key={`inline-code-${key++}`}
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
      >
        {match[1]}
      </code>,
    );
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
