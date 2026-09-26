/**
 * #196 — the large-document viewer benchmark from #190/#192, committed so its
 * numbers can be reproduced. Skipped unless `VIEWER_BENCH=1`: it is a
 * measurement, not a gate, and its timings depend on the machine.
 *
 *   VIEWER_BENCH=1 pnpm --filter ./ui exec vitest run tests/markdown-previewer.bench.test.tsx --silent=false --reporter=verbose
 *
 * By default it measures a synthetic ~600k-character document shaped like a
 * full-coverage generated document (H2 areas, H3 rules, a repeated H4, tables,
 * fences). To measure a real one, export its markdown to a file and set
 * `VIEWER_BENCH_DOC=/absolute/path/to/doc.md` — for example, from a copy of a
 * local database (never commit the document itself):
 *
 *   sqlite3 -readonly dev.db "SELECT content FROM generated_documents WHERE id='<id>'" > doc.md
 *
 * It reports, for the same document and in the same jsdom:
 *   - baseline: one react-markdown pass over the whole document with
 *     `rehype-slug` — what the pre-#190 viewer paid on a TOC jump to the last
 *     entry, when it rendered every section up to the target;
 *   - progressive: the current previewer's mount, and its TOC jump to the last
 *     entry (which renders one section);
 *   - duplicate heading ids and TOC entries with no matching heading in each.
 *
 * Mermaid is stubbed (jsdom cannot lay it out). jsdom does not implement
 * `content-visibility`, so the progressive mount includes laying out pending
 * sections a browser would skip; real-browser numbers need Playwright.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createElement } from "react";
import { act, fireEvent, render, cleanup } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import { describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg/>" }) },
}));
vi.mock("@/components/diagram-viewer", () => ({ DiagramViewer: () => <div /> }));
vi.stubGlobal(
  "IntersectionObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
window.HTMLElement.prototype.scrollIntoView = () => {};

import { MarkdownPreviewer } from "@/components/markdown-previewer";
import { splitMarkdownSections } from "@/lib/markdown-sections";

/** ~600k characters shaped like a full-coverage generated document. */
function syntheticDocument(targetChars = 611_000): string {
  const parts = ["# Business Requirements", "Preamble."];
  let i = 0;
  while (parts.join("\n").length < targetChars) {
    i += 1;
    if (i % 24 === 1) parts.push(`## Area ${Math.ceil(i / 24)}`);
    parts.push(`### Rule ${i}: _${i % 7 === 0 ? "Billing" : "Orders"}_ &amp; totals`);
    parts.push("The rule applies when a record changes. ".repeat(50));
    parts.push("| Field | Meaning |", "|---|---|", `| f${i} | value ${i} |`);
    parts.push("#### Edge Cases", "- none");
    if (i % 40 === 0) parts.push("```text", "## not a heading", "```");
  }
  return parts.join("\n");
}

function duplicateIds(root: ParentNode): number {
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  return ids.length - new Set(ids).size;
}

function time<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: Math.round(performance.now() - start), value };
}

describe.skipIf(process.env.VIEWER_BENCH !== "1")("large-document viewer benchmark (#196)", () => {
  const doc = process.env.VIEWER_BENCH_DOC
    ? readFileSync(process.env.VIEWER_BENCH_DOC, "utf8")
    : syntheticDocument();
  const { toc, sections } = splitMarkdownSections(doc);

  it("measures the whole-document baseline against the progressive viewer", async () => {
    const baseline = time(() =>
      render(
        createElement(
          ReactMarkdown,
          { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex, rehypeSlug] },
          doc,
        ),
      ),
    );
    const baselineIds = new Set(
      [...baseline.value.container.querySelectorAll("[id]")].map((el) => el.id),
    );
    const baselineDuplicates = duplicateIds(baseline.value.container);
    cleanup();

    const mount = time(() => render(<MarkdownPreviewer content={doc} />));
    const container = mount.value.container;
    const links = container.querySelectorAll('[data-testid="markdown-toc"] a');
    const last = links[links.length - 1];
    const jumpStart = performance.now();
    await act(async () => {
      fireEvent.click(last);
    });
    const jumpMs = Math.round(performance.now() - jumpStart);
    const target = container.querySelector(
      `[id="${CSS.escape(last.getAttribute("href")!.slice(1))}"]`,
    );
    const unmatchedToc = [...links].filter(
      (link) =>
        !container.querySelector(`[id="${CSS.escape(link.getAttribute("href")!.slice(1))}"]`),
    ).length;
    const unmatchedInBaseline = toc.filter((entry) => !baselineIds.has(entry.id)).length;

    const report = {
      characters: doc.length,
      sections: sections.length,
      tocEntries: toc.length,
      baselineWholeDocumentRenderMs: baseline.ms,
      progressiveMountMs: mount.ms,
      progressiveTocJumpToLastMs: jumpMs,
      progressiveRenderedSectionsAfterJump:
        container.querySelectorAll("[data-section-rendered]").length,
      baselineDuplicateIds: baselineDuplicates,
      progressiveDuplicateIds: duplicateIds(container),
      tocEntriesWithNoHeadingInBaseline: unmatchedInBaseline,
      tocEntriesWithNoHeadingProgressive: unmatchedToc,
    };
    // The report IS this file's output; it is a benchmark, not a gate.
    // eslint-disable-next-line no-console
    console.log(`viewer benchmark ${JSON.stringify(report, null, 2)}`);

    expect(target).not.toBeNull();
    expect(report.progressiveDuplicateIds).toBe(0);
    expect(report.tocEntriesWithNoHeadingProgressive).toBe(0);
  }, 300_000);
});
