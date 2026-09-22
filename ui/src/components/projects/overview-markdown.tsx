"use client";

/**
 * #1371 — the Project Overview body.
 *
 * Previously the page dumped `project_overview.md` into a `<pre>`, so
 * `# Project Overview`, `## Summary` and the whole symbol table printed
 * literally — a DOM check found **0** `table` elements — in low-contrast grey.
 *
 * This wraps the same GFM renderer Chat already uses, so headings and tables
 * become real elements, and pins the body copy to the theme's foreground tokens
 * rather than a hard-coded `text-zinc-400` that fails WCAG AA on a dark card.
 */
import { ChatMarkdown } from "@/components/chat/chat-markdown";

interface Props {
  markdown: string;
}

/**
 * #29 — the page's own `<h1>` ("Code Overview — name") names it; the generated
 * markdown opens with `# Project Overview — name` (server
 * `lib/code-graph/overview.ts`), which rendered a second `<h1>` and a second
 * page named "Overview". Every ATX heading moves down one level so the document
 * nests under the page title. Fenced code is left alone; `######` stays put.
 * Copy and Download still hand out the markdown unchanged.
 */
export function demoteHeadings(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        const marker = open[1][0];
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line.replace(/^(\s{0,3})(#{1,5})(?=\s|$)/, "$1#$2");
    })
    .join("\n");
}

export function OverviewMarkdown({ markdown }: Props): React.ReactElement {
  return (
    <div data-testid="overview-markdown" className="text-sm text-foreground">
      <ChatMarkdown content={demoteHeadings(markdown)} />
    </div>
  );
}
