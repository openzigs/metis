/**
 * #185 x #190 — a path-scoped document carries a "Scoped document" banner
 * directly under its H1 (server `withPathScopeBanner`). The progressive
 * previewer renders a large document section by section; the banner must land
 * in the first, eagerly rendered section — never in one that waits for a
 * scroll — so a scoped document is never read as a full-project one.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg/>" }) },
}));
vi.mock("@/components/diagram-viewer", () => ({ DiagramViewer: () => <div /> }));

class InertObserver {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
}
vi.stubGlobal("IntersectionObserver", InertObserver);
window.HTMLElement.prototype.scrollIntoView = vi.fn();

import { MarkdownPreviewer } from "@/components/markdown-previewer";

/** The exact shape `withPathScopeBanner` writes (server/src/lib/docs-gen/path-scope.ts). */
const BANNER =
  "> **Scoped document — not a full-project document.** Generated only from " +
  "`packages/fit/`; modules outside these paths were not read.";

function scopedDocument(): string {
  const parts = ["# Business Requirements [scope: packages/fit/]", "", BANNER, "", "Preamble."];
  for (let i = 1; i <= 120; i++) {
    parts.push(`## Area ${i}`, "The rule applies when records change. ".repeat(80));
  }
  return parts.join("\n");
}

describe("MarkdownPreviewer — scoped-document banner", () => {
  it("renders the scope banner and scoped H1 in the first section of a progressive render", () => {
    const { container } = render(<MarkdownPreviewer content={scopedDocument()} />);
    // Progressive mode is actually engaged: some sections are still pending.
    expect(container.querySelectorAll("[data-section-pending]").length).toBeGreaterThan(0);

    const first = container.querySelector("[data-section-rendered]");
    expect(first).not.toBeNull();
    const quote = first!.querySelector("blockquote");
    expect(quote?.textContent).toContain("Scoped document — not a full-project document.");
    expect(quote?.querySelector("code")?.textContent).toBe("packages/fit/");
    expect(first!.querySelector("h1")?.textContent).toBe(
      "Business Requirements [scope: packages/fit/]",
    );
  });
});
