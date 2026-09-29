/**
 * Issue #30 — findings filters: severity, category, agent, verification.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { FindingsFilterBar } from "./FindingsFilterBar";
import { NO_FINDING_FILTERS } from "./analysis-views";

const facets = {
  severities: ["critical", "high"],
  categories: ["architecture", "security"],
  agents: ["code", "custom:c-1"],
};

describe("FindingsFilterBar (#30)", () => {
  it("offers All plus the run's own values for each facet", () => {
    render(<FindingsFilterBar facets={facets} filters={NO_FINDING_FILTERS} onChange={vi.fn()} />);
    const severity = screen.getByLabelText(/Severity/);
    expect(
      within(severity)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All", "critical", "high"]);
    expect(within(screen.getByLabelText(/Category/)).getAllByRole("option")).toHaveLength(3);
  });

  it("labels agents through agentLabel", () => {
    render(
      <FindingsFilterBar
        facets={facets}
        filters={NO_FINDING_FILTERS}
        onChange={vi.fn()}
        agentLabel={(k) => (k === "code" ? "Code Analyst" : k)}
      />,
    );
    const agent = screen.getByLabelText(/Agent/);
    expect(within(agent).getByRole("option", { name: "Code Analyst" })).toHaveValue("code");
  });

  it("reports each facet change, keeping the others", () => {
    const onChange = vi.fn();
    const filters = { ...NO_FINDING_FILTERS, severity: "high" };
    render(<FindingsFilterBar facets={facets} filters={filters} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: "security" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, category: "security" });

    fireEvent.change(screen.getByLabelText(/Agent/), { target: { value: "custom:c-1" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, agentKey: "custom:c-1" });

    fireEvent.change(screen.getByLabelText(/Severity/), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, severity: null });

    fireEvent.click(screen.getByTestId("verification-filter-unverified"));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, verification: "unverified" });
  });

  it("marks the active verification button pressed", () => {
    render(
      <FindingsFilterBar
        facets={facets}
        filters={{ ...NO_FINDING_FILTERS, verification: "confirmed" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("verification-filter-confirmed")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("verification-filter-all")).toHaveAttribute("aria-pressed", "false");
  });

  it("offers Clear filters only while a filter is active, and clears them all", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FindingsFilterBar facets={facets} filters={NO_FINDING_FILTERS} onChange={onChange} />,
    );
    expect(screen.queryByTestId("finding-filter-clear")).not.toBeInTheDocument();

    for (const active of [
      { severity: "high" },
      { category: "security" },
      { agentKey: "code" },
      { verification: "confirmed" as const },
    ]) {
      rerender(
        <FindingsFilterBar
          facets={facets}
          filters={{ ...NO_FINDING_FILTERS, ...active }}
          onChange={onChange}
        />,
      );
      fireEvent.click(screen.getByTestId("finding-filter-clear"));
      expect(onChange).toHaveBeenLastCalledWith(NO_FINDING_FILTERS);
    }
  });
});
