/**
 * #272 — mermaid and the KaTeX stylesheet load when a message needs them.
 *
 * The module factories below record when the module is first EVALUATED. A
 * static import evaluates it as soon as the markdown component is imported,
 * before anything renders, which is what these tests reject.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const loaded = vi.hoisted(() => ({ mermaid: 0, katexCss: 0 }));
const mermaidApi = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: "<svg><text>diagram</text></svg>" })),
}));

vi.mock("mermaid", () => {
  loaded.mermaid += 1;
  return { default: mermaidApi };
});
vi.mock("katex/dist/katex.min.css", () => {
  loaded.katexCss += 1;
  return {};
});
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
vi.mock("@/components/diagram-viewer", () => ({
  DiagramViewer: ({ svg }: { svg: string }) => <div data-testid="diagram" data-svg={svg} />,
}));

import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { MarkdownPreviewer } from "@/components/markdown-previewer";

class InertObserver {
  observe = () => undefined;
  unobserve = () => undefined;
  disconnect = () => undefined;
  takeRecords = () => [];
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", InertObserver);
  mermaidApi.initialize.mockClear();
  mermaidApi.render.mockClear();
});

// Order matters: the "not loaded" cases run first, because a module stays
// evaluated for the rest of the file once anything has imported it.
describe("mermaid and KaTeX CSS are not loaded for plain markdown (#272)", () => {
  it("importing and rendering the markdown components loads neither", async () => {
    render(<ChatMarkdown content={"# Title\n\nPlain **text**, no diagram."} />);
    render(<MarkdownPreviewer content={"## Section\n\nAlso plain."} showToc={false} />);
    expect(screen.getByText("Title")).toBeInTheDocument();
    // Give the post-render mermaid pass (100–150 ms timers) time to run.
    await new Promise((r) => setTimeout(r, 250));
    expect(loaded.mermaid).toBe(0);
    expect(loaded.katexCss).toBe(0);
  });
});

describe("they load on demand (#272)", () => {
  it("loads the KaTeX stylesheet once math appears", async () => {
    render(<ChatMarkdown content={"Energy: $E = mc^2$"} />);
    await waitFor(() => expect(loaded.katexCss).toBe(1));
  });

  it("chat: loads mermaid for a diagram block and renders it", async () => {
    render(<ChatMarkdown content={"```mermaid\ngraph TD; A-->B\n```"} />);
    await waitFor(() => expect(mermaidApi.render).toHaveBeenCalled());
    expect(loaded.mermaid).toBe(1);
    expect(mermaidApi.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false }),
    );
    await waitFor(() => expect(screen.getByText("diagram")).toBeInTheDocument());
  });

  it("previewer: renders a diagram through the shared loader", async () => {
    render(<MarkdownPreviewer content={"```mermaid\ngraph TD; A-->B\n```"} showToc={false} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(mermaidApi.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", htmlLabels: false }),
    );
    // Still one evaluation: the loader shares a single import.
    expect(loaded.mermaid).toBe(1);
  });
});
