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

export function OverviewMarkdown({ markdown }: Props): React.ReactElement {
  return (
    <div data-testid="overview-markdown" className="text-sm text-foreground">
      <ChatMarkdown content={markdown} />
    </div>
  );
}
