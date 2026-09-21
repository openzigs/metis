/**
 * Issue #735 (Epic #726) — the deterministic affected-code panel renders one
 * collapsible section per requirement candidate with symbol/locator/relation/
 * confidence, an empty state for unmatched candidates, and nothing at all when
 * there is no mapping.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { AnalysisAffectedCode } from "@metis/shared";
import { AffectedCodePanel } from "@/components/analysis/affected-code-panel";

const mapping: AnalysisAffectedCode = {
  truncated: false,
  candidates: [
    {
      id: "NR-1",
      title: "Add a monthly invoice charge",
      body: "Add a monthly invoice charge",
      symbols: [
        {
          filePath: "server/src/billing/invoice.ts",
          qualifiedName: "InvoiceService.charge",
          startLine: 20,
          endLine: 40,
          relation: "direct",
          depth: 0,
          confidence: 0.92,
        },
        {
          filePath: "server/src/billing/controller.ts",
          qualifiedName: "BillingController.run",
          startLine: 10,
          endLine: 15,
          relation: "caller",
          depth: 1,
          confidence: 0.49,
        },
      ],
    },
    {
      id: "NR-2",
      title: "Add a refund endpoint",
      body: "Add a refund endpoint",
      symbols: [],
    },
  ],
};

afterEach(cleanup);

describe("AffectedCodePanel", () => {
  it("renders nothing when there is no mapping", () => {
    const { container } = render(<AffectedCodePanel affectedCode={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the mapping has no candidates", () => {
    const { container } = render(
      <AffectedCodePanel affectedCode={{ candidates: [], truncated: false }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each candidate's affected symbols with locator, relation and confidence", () => {
    render(<AffectedCodePanel affectedCode={mapping} />);
    expect(screen.getByTestId("affected-code-panel")).toBeInTheDocument();
    expect(screen.getByText("InvoiceService.charge")).toBeInTheDocument();
    expect(screen.getByText("server/src/billing/invoice.ts:20")).toBeInTheDocument();
    expect(screen.getByText("direct")).toBeInTheDocument();
    expect(screen.getByText("caller")).toBeInTheDocument();
    expect(screen.getByText(/conf 0\.92/)).toBeInTheDocument();
  });

  it("shows an empty state for a candidate with no matched code", () => {
    render(<AffectedCodePanel affectedCode={mapping} />);
    expect(screen.getByTestId("affected-code-empty-NR-2")).toHaveTextContent(/no code matched/i);
  });

  it("collapses a candidate when its header is toggled", () => {
    render(<AffectedCodePanel affectedCode={mapping} />);
    // Expanded by default → symbol is visible.
    expect(screen.getByText("InvoiceService.charge")).toBeInTheDocument();
    const header = screen.getByText("Add a monthly invoice charge");
    fireEvent.click(header);
    expect(screen.queryByText("InvoiceService.charge")).not.toBeInTheDocument();
  });
});
