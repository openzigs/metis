/**
 * Epic #726 (#734) — CodeCitation renders a finding's code evidence as its
 * `filePath:startLine-endLine` locator (chat #715 format), visually distinct
 * from document citations, with a copy-to-clipboard affordance.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeCitation } from "./code-citation";
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
