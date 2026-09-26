/**
 * #190 — a 600k-character generated document renders section by section:
 * never in one react-markdown pass, with every TOC anchor and deep link
 * resolving to exactly one heading, and unrendered text still in the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg/>" }) },
}));
vi.mock("@/components/diagram-viewer", () => ({ DiagramViewer: () => <div /> }));

/** An IntersectionObserver the test can drive. */
class ControlledObserver {
  static instances: ControlledObserver[] = [];
  observed = new Set<Element>();
  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    ControlledObserver.instances.push(this);
  }
  observe = (el: Element) => this.observed.add(el);
  unobserve = (el: Element) => this.observed.delete(el);
  disconnect = () => this.observed.clear();
}
vi.stubGlobal("IntersectionObserver", ControlledObserver);
const scrollIntoView = vi.fn();
window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

import { INITIAL_RENDERED_SECTIONS, MarkdownPreviewer } from "@/components/markdown-previewer";

/** Enter the viewport for `el` on the section observer that watches it. */
function intersect(el: Element) {
  const observer = ControlledObserver.instances.find(
    (o) => o.observed.has(el) && o.options?.rootMargin?.startsWith("1500px"),
  );
  if (!observer) throw new Error("element is not observed for rendering");
  act(() => {
    observer.callback(
      [{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

/** ~600k characters: 10 H2 areas, 240 H3 sections, duplicate headings, fences. */
function bigDocument(): string {
  const parts = ["# Business Requirements", "Preamble."];
  for (let i = 1; i <= 240; i++) {
    if (i % 24 === 1) parts.push(`## Area ${Math.ceil(i / 24)}`);
    parts.push(`### Rule ${i}`);
    parts.push(`Unique phrase marker-${i}. ` + "The rule applies when records change. ".repeat(60));
    // The same H4 in every section: ids must stay distinct document-wide.
    parts.push("#### Edge Cases", "- none");
    // A fence holding a deeper heading: the splitter must not cut it. (A
    // fenced H1–H4 is "repaired" into a real heading by `repairFences`.)
    if (i % 40 === 0) parts.push("```text", "##### not a heading", "```");
  }
  return parts.join("\n");
}

const rendered = (c: HTMLElement) => c.querySelectorAll("[data-section-rendered]");
const pending = (c: HTMLElement) => c.querySelectorAll("[data-section-pending]");

describe("MarkdownPreviewer — progressive rendering (#190)", () => {
  const doc = bigDocument();

  beforeEach(() => {
    ControlledObserver.instances = [];
    scrollIntoView.mockClear();
    window.location.hash = "";
  });
  afterEach(() => {
    window.location.hash = "";
  });

  it("renders only the first sections on open, never the whole document", () => {
    expect(doc.length).toBeGreaterThan(550_000);
    const { container } = render(<MarkdownPreviewer content={doc} />);
    expect(rendered(container)).toHaveLength(INITIAL_RENDERED_SECTIONS);
    // Preamble + 10 areas + 240 rules = 251 sections; the rest wait.
    expect(pending(container)).toHaveLength(251 - INITIAL_RENDERED_SECTIONS);
    // Pending sections are plain text, not markdown: no tables/lists built.
    expect(pending(container)[0].querySelector("ul, table, strong")).toBeNull();
  });

  it("keeps not-yet-rendered text in the page, so find-in-page still finds it", () => {
    const { container } = render(<MarkdownPreviewer content={doc} />);
    const last = pending(container)[pending(container).length - 1];
    expect(last.textContent).toContain("marker-240");
    // …and its heading anchor already exists before it renders.
    expect(container.querySelector("#rule-240")).not.toBeNull();
  });

  it("builds the table of contents from every H1–H3", () => {
    const { container } = render(<MarkdownPreviewer content={doc} />);
    const links = container.querySelectorAll('[data-testid="markdown-toc"] a');
    // 1 H1 + 10 H2 + 240 H3.
    expect(links).toHaveLength(251);
  });

  it("renders a section as it approaches the viewport", () => {
    const { container } = render(<MarkdownPreviewer content={doc} />);
    const next = pending(container)[0] as HTMLElement;
    const index = next.dataset.sectionPending;
    intersect(next);
    expect(container.querySelector(`[data-section-rendered="${index}"]`)).not.toBeNull();
    expect(rendered(container)).toHaveLength(INITIAL_RENDERED_SECTIONS + 1);
  });

  it("a TOC jump renders just the target section and scrolls to it", async () => {
    const { container } = render(<MarkdownPreviewer content={doc} />);
    const link = container.querySelector('[data-testid="markdown-toc"] a[href="#rule-240"]')!;
    await act(async () => {
      fireEvent.click(link);
    });
    expect(rendered(container)).toHaveLength(INITIAL_RENDERED_SECTIONS + 1);
    const target = container.querySelector("#rule-240")!;
    expect(target.closest("[data-section-rendered]")).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
  });

  it("every TOC anchor and every heading id is unique once all sections render", () => {
    const { container } = render(<MarkdownPreviewer content={doc} />);
    for (let guard = 0; pending(container).length && guard < 300; guard++) {
      intersect(pending(container)[0]);
    }
    expect(pending(container)).toHaveLength(0);
    const ids = [...container.querySelectorAll('[data-testid="markdown-content"] [id]')].map(
      (el) => el.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    // 240 "Edge Cases" H4s → edge-cases, edge-cases-1 … edge-cases-239.
    expect(ids).toContain("edge-cases-239");
    for (const link of container.querySelectorAll('[data-testid="markdown-toc"] a')) {
      const id = link.getAttribute("href")!.slice(1);
      expect(container.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    }
  });

  it("opens a deep link to an unrendered section (URL hash on load)", async () => {
    window.location.hash = "#rule-200";
    const { container } = render(<MarkdownPreviewer content={doc} />);
    await act(async () => {});
    const target = container.querySelector("#rule-200")!;
    expect(target.closest("[data-section-rendered]")).not.toBeNull();
    expect(scrollIntoView.mock.contexts).toContain(target);
  });

  it("follows a deep link to a nested heading and a later hash change", async () => {
    const { container } = render(<MarkdownPreviewer content={doc} />);
    await act(async () => {
      window.location.hash = "#edge-cases-150";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const target = container.querySelector("#edge-cases-150")!;
    expect(target).not.toBeNull();
    expect(target.tagName).toBe("H4");
    expect(scrollIntoView.mock.contexts).toContain(target);
  });

  it.each(["#nowhere", "#%E0%A4%A"])("ignores a hash that names no heading (%s)", async (hash) => {
    window.location.hash = hash;
    const { container } = render(<MarkdownPreviewer content={doc} />);
    await act(async () => {});
    expect(rendered(container)).toHaveLength(INITIAL_RENDERED_SECTIONS);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("starts over when the content changes", () => {
    const { container, rerender } = render(<MarkdownPreviewer content={doc} />);
    intersect(pending(container)[100]);
    expect(rendered(container)).toHaveLength(INITIAL_RENDERED_SECTIONS + 1);
    // Same shape, different document (e.g. the next version): nothing carries over.
    rerender(<MarkdownPreviewer content={doc.replace("Preamble.", "Revised preamble.")} />);
    expect(rendered(container)).toHaveLength(INITIAL_RENDERED_SECTIONS);
  });
});
