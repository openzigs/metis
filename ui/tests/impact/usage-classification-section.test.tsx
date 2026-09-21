import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SchemaUsageClassificationView } from "@metis/shared";
import {
  UsageClassificationSection,
  UsageBadge,
} from "@/components/impact/usage-classification-section";

function view(over: Partial<SchemaUsageClassificationView> = {}): SchemaUsageClassificationView {
  return {
    id: "c-1",
    projectId: "p-1",
    kind: "table",
    tableName: "crm.customers",
    columnName: null,
    columnType: null,
    usageClass: "used",
    uncertainReason: null,
    evidence: [
      {
        edgeKind: "reads",
        source: "mybatis",
        fromQualifiedName: "CustomerMapper.findById",
        reconciliation: "matched",
      },
    ],
    overriddenClass: null,
    computedAt: "2026-06-18T00:00:00.000Z",
    ...over,
  };
}

describe("UsageBadge", () => {
  it("renders the class label with a data attribute for each class", () => {
    const { rerender } = render(<UsageBadge usageClass="used" />);
    expect(screen.getByTestId("usage-badge").dataset.usageClass).toBe("used");
    rerender(<UsageBadge usageClass="unreferenced" />);
    expect(screen.getByTestId("usage-badge").dataset.usageClass).toBe("unreferenced");
    rerender(<UsageBadge usageClass="uncertain" />);
    expect(screen.getByTestId("usage-badge").dataset.usageClass).toBe("uncertain");
  });

  it("uncertain is visually distinct (destructive variant marker)", () => {
    render(<UsageBadge usageClass="uncertain" />);
    const badge = screen.getByTestId("usage-badge");
    expect(badge.dataset.distinct).toBe("true");
  });
});

describe("UsageClassificationSection", () => {
  it("renders nothing when there are no classified objects", () => {
    const { container } = render(<UsageClassificationSection objects={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a row per object with its usage badge", () => {
    render(
      <UsageClassificationSection
        objects={[
          view({ tableName: "crm.customers", usageClass: "used" }),
          view({ id: "c-2", tableName: "crm.audit_log", usageClass: "unreferenced", evidence: [] }),
          view({
            id: "c-3",
            tableName: "crm.legacy",
            usageClass: "uncertain",
            uncertainReason: "table-not-found",
            evidence: [],
          }),
        ]}
      />,
    );
    expect(screen.getByText("crm.customers")).toBeInTheDocument();
    expect(screen.getByText("crm.audit_log")).toBeInTheDocument();
    expect(screen.getByText("crm.legacy")).toBeInTheDocument();
    expect(screen.getAllByTestId("usage-badge")).toHaveLength(3);
  });

  it("never renders any drop/remove affordance", () => {
    render(
      <UsageClassificationSection objects={[view({ usageClass: "unreferenced", evidence: [] })]} />,
    );
    expect(screen.queryByRole("button", { name: /drop/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/drop/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bremove\b/i)).not.toBeInTheDocument();
  });

  it("filter toggle hides non-used objects while keeping the full schema accessible", () => {
    render(
      <UsageClassificationSection
        objects={[
          view({ tableName: "crm.customers", usageClass: "used" }),
          view({ id: "c-2", tableName: "crm.audit_log", usageClass: "unreferenced", evidence: [] }),
        ]}
      />,
    );
    // Initially both visible.
    expect(screen.getByText("crm.audit_log")).toBeInTheDocument();
    const toggle = screen.getByRole("checkbox", { name: /only show used/i });
    fireEvent.click(toggle);
    // Now only the used object is shown — the unreferenced row is filtered out.
    expect(screen.queryByText("crm.audit_log")).not.toBeInTheDocument();
    expect(screen.getByText("crm.customers")).toBeInTheDocument();
    // Toggling back restores the full schema.
    fireEvent.click(toggle);
    expect(screen.getByText("crm.audit_log")).toBeInTheDocument();
  });

  it("exposes evidence via an accessible tooltip (title) on the badge", () => {
    render(<UsageClassificationSection objects={[view()]} />);
    const badge = screen.getByTestId("usage-badge");
    expect(badge.getAttribute("title")).toContain("CustomerMapper.findById");
  });

  it("shows the uncertain reason in the row", () => {
    render(
      <UsageClassificationSection
        objects={[
          view({ usageClass: "uncertain", uncertainReason: "column-not-found", evidence: [] }),
        ]}
      />,
    );
    expect(screen.getByText(/column-not-found/)).toBeInTheDocument();
  });

  it("is keyboard/a11y accessible: section is a labelled region", () => {
    render(<UsageClassificationSection objects={[view()]} />);
    const region = screen.getByRole("region", { name: /used objects/i });
    expect(region).toBeInTheDocument();
  });

  it("renders column objects with their qualified column name", () => {
    render(
      <UsageClassificationSection
        objects={[
          view({
            id: "col-1",
            kind: "column",
            tableName: "crm.customers",
            columnName: "email",
            usageClass: "used",
          }),
        ]}
      />,
    );
    expect(screen.getByText("crm.customers.email")).toBeInTheDocument();
  });

  it("renders procedure/function objects with their qualified name and kind (#302)", () => {
    render(
      <UsageClassificationSection
        objects={[
          view({
            id: "fn-1",
            kind: "function",
            tableName: "app.calc_total",
            columnName: null,
            usageClass: "used",
          }),
          view({
            id: "p-1",
            kind: "procedure",
            tableName: "app.never_called",
            columnName: null,
            usageClass: "unreferenced",
            evidence: [],
          }),
        ]}
      />,
    );
    expect(screen.getByText("app.calc_total")).toBeInTheDocument();
    expect(screen.getByText("app.never_called")).toBeInTheDocument();
    // The object-kind label reflects the routine kind.
    const rows = screen.getAllByTestId("usage-classification-row");
    expect(rows.some((r) => r.textContent?.includes("function"))).toBe(true);
    expect(rows.some((r) => r.textContent?.includes("procedure"))).toBe(true);
  });
});
