/**
 * Epic #475 (Phase 5, #490) — A03 XSS hardening proof for the discussion surface.
 *
 * Discussion message bodies (human AND AI) render through the shared, XSS-safe
 * `ChatMarkdown` renderer (`DiscussionMessageItem` → `ChatMarkdown`). `ChatMarkdown`
 * uses `react-markdown` WITHOUT `rehype-raw`, so embedded raw HTML is never parsed
 * as markup — it is escaped to text. The only `dangerouslySetInnerHTML` in the
 * renderer is a DOMPurify-sanitized Mermaid SVG (`securityLevel: "strict"`), which
 * cannot originate from a plain message body.
 *
 * This suite probes several classic injection vectors and asserts each renders
 * INERT (no executable element / no dangerous attribute reaches the DOM). A
 * malicious mention (`@<img onerror>`) is included to prove mention text can't
 * smuggle markup either.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  streamFetch: vi.fn(),
  setOnRefreshFailure: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import {
  DiscussionMessageItem,
  type DiscussionListMessage,
} from "@/components/chat/discussion-message-list";

function msg(body: string): DiscussionListMessage {
  return {
    id: "m1",
    threadId: "t1",
    authorKind: "human",
    authorUserId: "u1",
    aiProvider: null,
    aiModel: null,
    aiSessionId: null,
    body,
    createdAt: new Date().toISOString(),
    editedAt: null,
  };
}

function renderBody(body: string) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <DiscussionMessageItem message={msg(body)} />
    </Wrapper>,
  );
}

describe("A03 XSS — discussion message bodies render inert", () => {
  it("does not inject a <script> element", () => {
    const { container } = renderBody("hi <script>window.__pwned = true</script> there");
    expect(container.querySelector("script")).toBeNull();
    // The dangerous global was never set.
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("does not inject an <img onerror=...> handler", () => {
    const { container } = renderBody('<img src=x onerror="window.__img=1">');
    const img = container.querySelector("img");
    // Either no img element, or one with no onerror attribute — never an
    // executable handler.
    expect(img?.getAttribute("onerror") ?? null).toBeNull();
    expect((window as unknown as { __img?: number }).__img).toBeUndefined();
  });

  it("does not inject an <iframe>", () => {
    const { container } = renderBody('<iframe src="javascript:alert(1)"></iframe>');
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("does not produce a javascript: href anchor", () => {
    const { container } = renderBody("[click me](javascript:alert(document.cookie))");
    const anchors = Array.from(container.querySelectorAll("a"));
    for (const a of anchors) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
  });

  it("does not inject an inline event handler via an svg/onload payload", () => {
    const { container } = renderBody('<svg><script>1</script></svg><body onload="window.__ol=1">');
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __ol?: number }).__ol).toBeUndefined();
  });

  it("renders a mention containing markup as inert text (no smuggled element)", () => {
    const { container } = renderBody('hey @<img src=x onerror="window.__m=1"> please review');
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect((window as unknown as { __m?: number }).__m).toBeUndefined();
  });

  it("still renders legitimate markdown formatting (defense isn't over-broad)", () => {
    const { getByText } = renderBody("**bold** and `code` and a [safe link](https://example.com)");
    expect(getByText("bold")).toBeInTheDocument();
    expect(getByText("code")).toBeInTheDocument();
  });
});
