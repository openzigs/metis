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
    expect(empty).toHaveTextContent(
      /No symbol's name shares two of this requirement's terms and its subject/,
    );
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
    // #1063 (run 9) — the subject rules and the test-code exclusion are stated.
    expect(panel).toHaveTextContent(/the symbol or the type it belongs to must name it too/);
    expect(panel).toHaveTextContent(
      /a type is shown only when the requirement uses the last word of its name, and a table column only when the requirement names its table/,
    );
    expect(panel).toHaveTextContent(/Test code is not shown/);
    // A run recorded before #1097 carries no ranking: its confidence was relative.
    expect(panel).toHaveTextContent(/not a probability/);
    expect(panel).not.toHaveTextContent(/Ranked by/);
  });

  it("#1097 — a hybrid run says so, states the confidence floor, and that confidence is absolute", () => {
    render(<AffectedCodePanel affectedCode={{ ...affectedCode, retrievalMode: "hybrid" }} />);
    const panel = screen.getByTestId("affected-code-explainer");
    expect(panel).toHaveTextContent(/Ranked by meaning and keywords together/);
    expect(panel).toHaveTextContent(/confidence is at least 0.08/);
    expect(panel).not.toHaveTextContent(/shares at least two of the requirement's terms/);
    expect(panel).toHaveTextContent(/same scale for every requirement/);
    expect(panel).not.toHaveTextContent(/not a probability/);
    expect(screen.getByTestId("affected-code-empty-NR-4")).toHaveTextContent(
      /No symbol is close enough to this requirement and about its subject/,
    );
  });

  it("#1097 — a keyword-only run says the embeddings were not used, and keeps the two-term rule", () => {
    render(<AffectedCodePanel affectedCode={{ ...affectedCode, retrievalMode: "bm25-only" }} />);
    const panel = screen.getByTestId("affected-code-explainer");
    expect(panel).toHaveTextContent(/Ranked by keywords only/);
    expect(panel).toHaveTextContent(/Re-run once embedding has finished to compare/);
    expect(panel).toHaveTextContent(/shares at least two of the requirement's terms/);
    expect(panel).toHaveTextContent(/same scale for every requirement/);
  });

  const sym = (name: string, confidence: number) => ({
    filePath: `internal/${name}.go`,
    qualifiedName: `internal/${name}.go::${name}`,
    startLine: 1,
    endLine: 2,
    relation: "direct" as const,
    depth: 0,
    confidence,
  });

  it("#1097 review — folds links under 0.15 into a 'weaker matches' disclosure on an absolute run", () => {
    render(
      <AffectedCodePanel
        affectedCode={{
          truncated: false,
          retrievalMode: "hybrid",
          candidates: [
            {
              id: "NR-1",
              title: "Terminate all sessions",
              body: "Terminate all sessions",
              retrievalMode: "hybrid",
              symbols: [
                sym("FlushAllSessions", 0.16),
                sym("removeSession", 0.14),
                sym("Parse", 0.09),
              ],
            },
            {
              id: "NR-2",
              title: "Only weak",
              body: "Only weak",
              symbols: [sym("WithFeedID", 0.09)],
            },
          ],
        }}
      />,
    );
    const first = screen.getByTestId("affected-code-candidate-NR-1");
    const weaker = screen.getByTestId("affected-code-weaker-NR-1");
    expect(weaker).toHaveTextContent(/2 weaker matches \(confidence under 0\.15\)/);
    expect(weaker).toHaveTextContent("removeSession");
    expect(weaker).not.toHaveTextContent("FlushAllSessions");
    expect(weaker).not.toHaveAttribute("open");
    expect(first).toHaveTextContent("FlushAllSessions");
    expect(screen.getByTestId("affected-code-no-strong-NR-2")).toHaveTextContent(
      /No link reaches 0\.15/,
    );
    expect(screen.getByTestId("affected-code-weaker-NR-2")).toHaveTextContent(/1 weaker match /);
    expect(screen.getByTestId("affected-code-explainer")).toHaveTextContent(
      /Links under 0\.15 are folded under "weaker matches"/,
    );
  });

  it("#1097 review — does not fold a pre-#1097 run (relative confidences)", () => {
    render(
      <AffectedCodePanel
        affectedCode={{
          truncated: false,
          candidates: [{ id: "NR-1", title: "t", body: "t", symbols: [sym("a", 0.1)] }],
        }}
      />,
    );
    expect(screen.queryByTestId("affected-code-weaker-NR-1")).toBeNull();
    expect(screen.getByTestId("affected-code-candidate-NR-1")).toHaveTextContent("conf 0.10");
  });

  it("#1097 review — a mixed run explains both rules and labels each requirement's ranking", () => {
    render(
      <AffectedCodePanel
        affectedCode={{
          truncated: false,
          retrievalMode: "mixed",
          candidates: [
            { id: "NR-1", title: "a", body: "a", retrievalMode: "hybrid", symbols: [] },
            { id: "NR-2", title: "b", body: "b", retrievalMode: "bm25-only", symbols: [] },
          ],
        }}
      />,
    );
    const panel = screen.getByTestId("affected-code-explainer");
    expect(panel).toHaveTextContent(/Some requirements were ranked by meaning and keywords/);
    expect(panel).toHaveTextContent(/confidence is at least 0\.08/);
    expect(panel).toHaveTextContent(/shares at least two of the requirement's terms/);
    expect(screen.getByTestId("affected-code-ranking-NR-1")).toHaveTextContent(
      "meaning + keywords",
    );
    expect(screen.getByTestId("affected-code-ranking-NR-2")).toHaveTextContent("keywords only");
    expect(screen.getByTestId("affected-code-empty-NR-1")).toHaveTextContent(/close enough/);
    expect(screen.getByTestId("affected-code-empty-NR-2")).toHaveTextContent(/shares two/);
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
