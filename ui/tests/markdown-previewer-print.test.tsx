/**
 * #1182 — printing a long document renders every section first.
 *
 * The previewer renders a few sections on open and the rest as they near the
 * viewport (#190). A pending section is plain text: its raw Markdown. Printing
 * (Ctrl+P, "Save as PDF") must not put that raw text on paper, so a print
 * request renders every section — synchronously, because the browser lays out
 * the print copy right after `beforeprint` returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg/>" }) },
}));
vi.mock("@/components/diagram-viewer", () => ({ DiagramViewer: () => <div /> }));

/** Sections never come into view on their own in this file. */
class InertObserver {
  observe = () => {};
  unobserve = () => {};
  disconnect = () => {};
}
vi.stubGlobal("IntersectionObserver", InertObserver);

import { INITIAL_RENDERED_SECTIONS, MarkdownPreviewer } from "@/components/markdown-previewer";

const SECTIONS = 12;

/** A BRD-shaped document: every section carries a checklist and bold text. */
function longBrd(): string {
  const parts = ["# Business Requirements Document", "Preamble."];
  for (let i = 1; i <= SECTIONS; i++) {
    parts.push(`### R${i} — Requirement ${i}`);
    parts.push(`The system **must** handle case ${i}.`);
    parts.push("- [ ] Acceptance criterion one", "- [ ] Acceptance criterion two");
  }
  return parts.join("\n");
}

const rendered = (c: HTMLElement) => c.querySelectorAll("[data-section-rendered]");
const pending = (c: HTMLElement) => c.querySelectorAll("[data-section-pending]");

/** A `matchMedia('print')` the test can flip, as Safari does without `beforeprint`. */
function controllablePrintQuery() {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const legacy = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: false,
    media: "print",
    onchange: null,
    addEventListener: (_t: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
    removeEventListener: (_t: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
    addListener: (l: (e: MediaQueryListEvent) => void) => legacy.add(l),
    removeListener: (l: (e: MediaQueryListEvent) => void) => legacy.delete(l),
    dispatchEvent: () => false,
  };
  return {
    mql,
    listenerCount: () => listeners.size + legacy.size,
    enterPrint() {
      mql.matches = true;
      const event = { matches: true, media: "print" } as MediaQueryListEvent;
      for (const l of [...listeners, ...legacy]) l(event);
    },
  };
}

describe("MarkdownPreviewer — printing renders every section (#1182)", () => {
  const doc = longBrd();
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    window.location.hash = "";
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("still renders lazily on open, before any print request", () => {
    const { container } = render(<MarkdownPreviewer content={doc} />);
    expect(rendered(container)).toHaveLength(INITIAL_RENDERED_SECTIONS);
    expect(pending(container).length).toBeGreaterThan(0);
    // A pending section holds its raw Markdown — what a print used to show.
    expect(container.textContent).toContain("- [ ] Acceptance criterion one");
  });

  it("renders every section's HTML synchronously on beforeprint", () => {
    const { container } = render(<MarkdownPreviewer content={doc} />);
    expect(pending(container).length).toBeGreaterThan(0);

    // No act(): the browser snapshots the page for print as soon as the
    // event's listeners return, so the DOM must already be complete here.
    window.dispatchEvent(new Event("beforeprint"));

    expect(pending(container)).toHaveLength(0);
    expect(rendered(container)).toHaveLength(SECTIONS + 1);
    expect(container.textContent).not.toContain("- [ ]");
    expect(container.textContent).not.toContain("**must**");
    expect(container.querySelectorAll("strong")).toHaveLength(SECTIONS);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(SECTIONS * 2);
  });

  it("renders every section when matchMedia('print') starts matching", () => {
    const print = controllablePrintQuery();
    window.matchMedia = vi.fn((query: string) =>
      query === "print" ? print.mql : originalMatchMedia(query),
    ) as unknown as typeof window.matchMedia;

    const { container } = render(<MarkdownPreviewer content={doc} />);
    expect(pending(container).length).toBeGreaterThan(0);

    print.enterPrint();

    expect(pending(container)).toHaveLength(0);
    expect(container.textContent).not.toContain("- [ ]");
  });

  it("removes its print listeners on unmount", () => {
    const print = controllablePrintQuery();
    window.matchMedia = vi.fn((query: string) =>
      query === "print" ? print.mql : originalMatchMedia(query),
    ) as unknown as typeof window.matchMedia;
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = render(<MarkdownPreviewer content={doc} />);
    expect(print.listenerCount()).toBe(1);
    act(() => unmount());

    expect(print.listenerCount()).toBe(0);
    expect(removeSpy.mock.calls.some(([type]) => type === "beforeprint")).toBe(true);
    removeSpy.mockRestore();
  });

  // #1279 — Mermaid draws after a timer and an async load; the print copy is
  // laid out as soon as `beforeprint` returns. jsdom applies no print CSS, so
  // this pins the markup the `print:` variants act on; the Playwright spec
  // `doc-print-diagram.spec.ts` checks what print media actually shows.
  it("an undrawn diagram prints a plain note, never the 'Rendering diagram…' spinner", () => {
    const withDiagram = `${doc}\n### R99 — Flow\n\n\`\`\`mermaid\ngraph TD\n  A-->B\n\`\`\`\n`;
    const { container } = render(<MarkdownPreviewer content={withDiagram} />);
    expect(container.querySelector("code.language-mermaid")).toBeNull();

    window.dispatchEvent(new Event("beforeprint"));

    const placeholder = container.querySelector("code.language-mermaid")?.closest("div");
    expect(placeholder).toBeTruthy();
    const spinner = Array.from(placeholder!.querySelectorAll("div")).find(
      (el) => el.textContent === "Rendering diagram…",
    );
    expect(spinner?.className.split(/\s+/)).toContain("print:hidden");
    const note = Array.from(placeholder!.querySelectorAll("p")).find((el) =>
      /still being drawn when printing started/.test(el.textContent ?? ""),
    );
    expect(note?.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "print:block"]));
    expect(note!.textContent).toMatch(/print again/);
  });

  it("is a no-op when every section is already rendered", () => {
    const short = "# Title\n\nOnly one section.";
    const { container } = render(<MarkdownPreviewer content={short} />);
    window.dispatchEvent(new Event("beforeprint"));
    expect(rendered(container)).toHaveLength(1);
    expect(pending(container)).toHaveLength(0);
  });
});
