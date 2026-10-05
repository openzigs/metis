/**
 * Epic #726 (#734) — CodeCitation renders a finding's code evidence as its
 * `filePath:startLine-endLine` locator (chat #715 format), visually distinct
 * from document citations, with a copy-to-clipboard affordance.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeCitation } from "./code-citation";
import { CodeCitationRepoContext } from "./code-citation-repo-context";
import {
  formatCodeCitationLocator,
  isCodeCitation,
  type AnalysisCitation,
} from "@/lib/analysis-api";

describe("isCodeCitation", () => {
  it("discriminates code vs document citations", () => {
    const code: AnalysisCitation = { filePath: "a/b.ts", startLine: 3, endLine: 9 };
    const doc: AnalysisCitation = { documentId: "d1", chunkIndex: 0 };
    expect(isCodeCitation(code)).toBe(true);
    expect(isCodeCitation(doc)).toBe(false);
  });

  it("formats the canonical locator", () => {
    expect(formatCodeCitationLocator({ filePath: "a/b.ts", startLine: 3, endLine: 9 })).toBe(
      "a/b.ts:3-9",
    );
  });
});

describe("CodeCitation", () => {
  it("renders the filePath:startLine-endLine locator and a code badge", () => {
    render(
      <ul>
        <CodeCitation
          citation={{ filePath: "server/src/auth/session.ts", startLine: 10, endLine: 42 }}
        />
      </ul>,
    );
    expect(screen.getByText("server/src/auth/session.ts:10-42")).toBeInTheDocument();
    expect(screen.getByTestId("code-citation-badge")).toHaveTextContent("code");
  });

  it("copies the locator to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <ul>
        <CodeCitation citation={{ filePath: "a/b.ts", startLine: 1, endLine: 5 }} />
      </ul>,
    );
    await userEvent.click(screen.getByTestId("code-citation-copy"));
    expect(writeText).toHaveBeenCalledWith("a/b.ts:1-5");
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });
});

describe("CodeCitation — #728 GitHub blob links", () => {
  const repo = { origin: "https://github.com", owner: "miniflux", repo: "v2", ref: "v2.3.3" };

  it("renders the locator as plain text when no repo is known", () => {
    render(
      <ul>
        <CodeCitation citation={{ filePath: "a.go", startLine: 1, endLine: 5 }} />
      </ul>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("a.go:1-5").tagName).toBe("CODE");
  });

  it("links the locator to the GitHub blob in a new tab and keeps Copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <CodeCitationRepoContext.Provider value={repo}>
        <ul>
          <CodeCitation citation={{ filePath: "internal/feed.go", startLine: 10, endLine: 42 }} />
        </ul>
      </CodeCitationRepoContext.Provider>,
    );
    const link = screen.getByRole("link", { name: /internal\/feed\.go:10-42/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/miniflux/v2/blob/v2.3.3/internal/feed.go#L10-L42",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await userEvent.click(screen.getByTestId("code-citation-copy"));
    expect(writeText).toHaveBeenCalledWith("internal/feed.go:10-42");
  });

  it("keeps an unsafe path as plain text even when a repo is known", () => {
    render(
      <CodeCitationRepoContext.Provider value={repo}>
        <ul>
          <CodeCitation citation={{ filePath: "../secret.go", startLine: 1, endLine: 1 }} />
        </ul>
      </CodeCitationRepoContext.Provider>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("../secret.go:1-1")).toBeInTheDocument();
  });
});
