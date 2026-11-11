/** #2242 — under a reply: its citations, verified ones linked, the rest marked. */
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/connectors-api", () => ({ repoConnectorsApi: { list } }));

import type { ChatCitation } from "@/lib/ai-client";
import type { CodeCitationRepo } from "@/lib/code-citation-blob-url";
import { CitationList, CitationListView, citationHref, citationSummary } from "./citation-list";

const repo: CodeCitationRepo = {
  origin: "https://github.com",
  owner: "acme",
  repo: "reader",
  ref: "0123456789abcdef0123456789abcdef01234567",
};

const verifiedCode: ChatCitation = {
  text: "internal/model/feed.go:120-150",
  path: "internal/model/feed.go",
  lines: [120, 150],
  status: "verified",
  source: "repo",
};
const verifiedDoc: ChatCitation = {
  text: "[2]",
  path: "FRD-12.md",
  status: "verified",
  source: "document",
};
const fabricated: ChatCitation = {
  text: "internal/made/up.go:3",
  path: "internal/made/up.go",
  lines: [3, 3],
  status: "not-read",
};
const wrongLines: ChatCitation = {
  ...verifiedCode,
  text: "feed.go:900",
  lines: [900, 900],
  status: "span-unverified",
};

describe("citationHref", () => {
  it("links a verified citation of the project's code to its lines on GitHub", () => {
    expect(citationHref(verifiedCode, repo)).toBe(
      `https://github.com/acme/reader/blob/${repo.ref}/internal/model/feed.go#L120-L150`,
    );
    expect(citationHref({ ...verifiedCode, lines: undefined }, repo)).toBe(
      `https://github.com/acme/reader/blob/${repo.ref}/internal/model/feed.go`,
    );
  });

  it("links nothing that is unverified, a document, or without a repo", () => {
    expect(citationHref(wrongLines, repo)).toBeNull();
    expect(citationHref(fabricated, repo)).toBeNull();
    expect(citationHref(verifiedDoc, repo)).toBeNull();
    expect(citationHref(verifiedCode, null)).toBeNull();
  });
});

describe("citationSummary", () => {
  it("counts the verified and the rest", () => {
    expect(citationSummary([verifiedCode, verifiedDoc])).toBe("Citations · 2 verified");
    expect(citationSummary([verifiedCode, fabricated, wrongLines])).toBe(
      "Citations · 1 verified · 2 not verified",
    );
  });
});

describe("CitationList", () => {
  it("renders nothing when the reply cited nothing", () => {
    // No QueryClient here: with nothing cited, the repo is never looked up.
    const { container } = render(<CitationList citations={undefined} projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
    const { container: empty } = render(<CitationList citations={[]} projectId="p1" />);
    expect(empty).toBeEmptyDOMElement();
    const { container: view } = render(<CitationListView citations={[]} repo={repo} />);
    expect(view).toBeEmptyDOMElement();
  });

  it("links a verified code citation and marks the ones that did not resolve", () => {
    render(
      <CitationListView
        citations={[verifiedCode, verifiedDoc, fabricated, wrongLines]}
        repo={repo}
      />,
    );
    const list = screen.getByTestId("chat-citations");
    // Open when something did not resolve, so the problem is seen.
    expect(list).toHaveAttribute("open");
    const items = within(list).getAllByTestId("chat-citation");
    expect(items.map((i) => i.getAttribute("data-status"))).toEqual([
      "verified",
      "verified",
      "not-read",
      "span-unverified",
    ]);
    const link = within(items[0]!).getByRole("link", { name: verifiedCode.text });
    expect(link).toHaveAttribute("href", citationHref(verifiedCode, repo));
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(items[1]!.textContent).toBe("✓ [2] → FRD-12.md — in the sources this reply read");
    expect(within(items[2]!).queryByRole("link")).toBeNull();
    expect(items[2]!.textContent).toBe(
      "✗ internal/made/up.go:3 — not in anything this reply retrieved or read",
    );
    expect(items[3]!.textContent).toContain("the file was read, but not these lines");
    expect(items[3]!.textContent).toContain("→ internal/model/feed.go");
  });

  it("links into the project's own GitHub repo, read from its connectors", async () => {
    list.mockResolvedValue([
      {
        provider: "github",
        ownerOrOrg: "acme",
        repoName: "reader",
        defaultBranch: "main",
        apiBaseUrl: null,
        lastCommitSha: repo.ref,
        deletedAt: null,
      },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CitationList citations={[verifiedCode]} projectId="p1" />
      </QueryClientProvider>,
    );
    const link = await screen.findByRole("link", { name: verifiedCode.text });
    expect(link).toHaveAttribute("href", citationHref(verifiedCode, repo));
    expect(list).toHaveBeenCalledWith("p1");
  });

  it("stays closed and muted when every citation was verified", () => {
    render(<CitationListView citations={[verifiedCode]} repo={repo} />);
    const list = screen.getByTestId("chat-citations");
    expect(list).not.toHaveAttribute("open");
    expect(list.className).toContain("text-muted-foreground");
  });
});
