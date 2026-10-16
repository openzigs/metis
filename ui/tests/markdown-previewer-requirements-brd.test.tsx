/**
 * #1170 — walkthrough run 9 read a requirements BRD as "stopping after R2's
 * clarification marker". The stored body was whole: the sections after that
 * point were still pending (progressive rendering, #190), and a pending section
 * is `content-visibility: auto`, so a text read or an early screenshot skips it.
 * This pins the renderer side: a BRD in the shape run 9 stored, marker text and
 * all, renders every requirement once its sections are reached — nothing in it
 * opens a comment that swallows the rest.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg/>" }) },
}));
vi.mock("@/components/diagram-viewer", () => ({ DiagramViewer: () => <div /> }));

class ControlledObserver {
  static instances: ControlledObserver[] = [];
  observed = new Set<Element>();
  constructor(public callback: IntersectionObserverCallback) {
    ControlledObserver.instances.push(this);
  }
  observe = (el: Element) => this.observed.add(el);
  unobserve = (el: Element) => this.observed.delete(el);
  disconnect = () => this.observed.clear();
}
vi.stubGlobal("IntersectionObserver", ControlledObserver);
window.HTMLElement.prototype.scrollIntoView = vi.fn();

import { MarkdownPreviewer } from "@/components/markdown-previewer";

/** One requirement as the pre-#1170 generator wrote it: markers escaped into text. */
function storedRequirement(n: number): string {
  return [
    `### R${n}. Requirement ${n}`,
    "",
    `Body ${n}.`,
    "",
    "&lt;!-- metis:clarifications:start -->",
    "## Clarifications",
    "",
    `> **Check the acceptance criteria.** &lt;!-- metis:criteria-predate-answers -->`,
    "",
    `- **Q:** Question ${n}?`,
    `  **A:** Answer ${n}.`,
    "&lt;!-- metis:clarifications:end -->",
    "",
    "#### Acceptance criteria",
    "",
    `- Criterion ${n}.`,
    "",
    "<!-- metis:clarifications:start -->",
    "",
  ].join("\n");
}

const brd = ["# BRD (5 requirements)", "", "## Requirements", ""]
  .concat([1, 2, 3, 4, 5].map(storedRequirement))
  .join("\n");

/** Bring every pending section into view, as scrolling to the end does. */
function renderEverySection(container: HTMLElement): void {
  for (let pass = 0; pass < 20; pass++) {
    const pending = Array.from(container.querySelectorAll("[data-section-pending]"));
    if (pending.length === 0) return;
    for (const el of pending) {
      const observer = ControlledObserver.instances.find((o) => o.observed.has(el));
      act(() => {
        observer?.callback(
          [{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry],
          observer as unknown as IntersectionObserver,
        );
      });
    }
  }
}

describe("MarkdownPreviewer — a requirements BRD (#1170)", () => {
  it("renders every requirement, with its answers and criteria, once its sections are reached", () => {
    const { container } = render(<MarkdownPreviewer content={brd} />);
    renderEverySection(container);
    expect(container.querySelectorAll("[data-section-pending]")).toHaveLength(0);
    const text = container.querySelector("[data-testid=markdown-content]")?.textContent ?? "";
    for (const n of [1, 2, 3, 4, 5]) {
      expect(text).toContain(`R${n}. Requirement ${n}`);
      expect(text).toContain(`Answer ${n}.`);
      expect(text).toContain(`Criterion ${n}.`);
    }
  });
});
