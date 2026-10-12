/**
 * Issue #1063 — the deterministic affected-code panel says honestly when a
 * requirement has no code link, and what a link and its confidence mean.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AnalysisAffectedCode } from "@/lib/analysis-api";
import { AffectedCodePanel } from "./affected-code-panel";

const affectedCode: AnalysisAffectedCode = {
  truncated: false,
  candidates: [
    {
      id: "NR-1",
      title: "Mark all as read older than X",
      body: "Mark all as read older than X",
      symbols: [
        {
          filePath: "internal/ui/unread_mark_all_read.go",
          qualifiedName: "internal/ui/unread_mark_all_read.go::markAllAsRead",
          startLine: 13,
          endLine: 20,
          relation: "direct",
          depth: 0,
          confidence: 1,
        },
      ],
    },
    {
      id: "NR-4",
      title: "Add a button to terminate all sessions",
      body: "Add a button to terminate all sessions",
      symbols: [],
    },
  ],
};

describe("AffectedCodePanel", () => {
  it("renders nothing when there is no mapping", () => {
    const { container } = render(<AffectedCodePanel affectedCode={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists a linked symbol with its locator, relation and confidence", () => {
    render(<AffectedCodePanel affectedCode={affectedCode} />);
    const candidate = screen.getByTestId("affected-code-candidate-NR-1");
    expect(candidate).toHaveTextContent("markAllAsRead");
    expect(candidate).toHaveTextContent("internal/ui/unread_mark_all_read.go:13");
    expect(candidate).toHaveTextContent("direct");
    expect(candidate).toHaveTextContent("conf 1.00");
    expect(candidate).toHaveTextContent("1 symbol");
  });

  it("says a requirement has no code link instead of showing a weak guess", () => {
    render(<AffectedCodePanel affectedCode={affectedCode} />);
    expect(screen.getByTestId("affected-code-candidate-NR-4")).toHaveTextContent("0 symbols");
    const empty = screen.getByTestId("affected-code-empty-NR-4");
    expect(empty).toHaveTextContent(/No code matched/);
    expect(empty).toHaveTextContent(/No symbol's name shares two of this requirement's terms/);
    expect(empty).toHaveTextContent(/nothing is linked rather than showing a weak guess/);
    // The agent's seed list is wider than what is shown (PR #1095 review).
    expect(empty).toHaveTextContent(
      /code agent still investigates it, and may start from weaker candidates that are not shown here/,
    );
  });

  it("explains the linking rule and that confidence is relative", () => {
    render(<AffectedCodePanel affectedCode={affectedCode} />);
    const panel = screen.getByTestId("affected-code-panel");
    expect(panel).toHaveTextContent(/shares at least two of the requirement's terms/);
    // The rule is on the NAME: a directory or file extension is not a shared term.
    expect(panel).toHaveTextContent(
      /symbol's name \(with its enclosing type or table, never its file path\)/,
    );
    expect(panel).toHaveTextContent(/callers and importers of a direct match are listed with it/);
    expect(panel).toHaveTextContent(/not a probability/);
  });

  it("notes when the prompt block was cut for length", () => {
    render(<AffectedCodePanel affectedCode={{ ...affectedCode, truncated: true }} />);
    expect(screen.getByTestId("affected-code-panel")).toHaveTextContent(
      /omitted from the analysis prompt for length/,
    );
  });

  it("collapses and reopens a candidate", () => {
    render(<AffectedCodePanel affectedCode={affectedCode} />);
    const toggle = screen.getByRole("button", { name: /NR-4/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("affected-code-empty-NR-4")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("affected-code-empty-NR-4")).toBeInTheDocument();
  });

  it("shows a path alone when a symbol has no line", () => {
    render(
      <AffectedCodePanel
        affectedCode={{
          truncated: false,
          candidates: [
            {
              id: "NR-1",
              title: "t",
              body: "t",
              symbols: [
                {
                  filePath: "a/b.go",
                  qualifiedName: "a/b.go",
                  startLine: null,
                  endLine: null,
                  relation: "caller",
                  depth: 1,
                  confidence: 0.6,
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("affected-code-candidate-NR-1")).toHaveTextContent("caller");
    expect(screen.getByTestId("affected-code-candidate-NR-1")).not.toHaveTextContent("a/b.go:");
  });
});
