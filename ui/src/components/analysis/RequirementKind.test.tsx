/**
 * Issue #1615 — a requirement's functional / non-functional kind (#1612) is
 * shown on its card and filters the list. Null means "not classified" and is
 * never read as either kind.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { matchesKindFilter, RequirementKindBadge, RequirementKindFilter } from "./RequirementKind";

describe("matchesKindFilter", () => {
  it("keeps everything with no filter, and only the matching kind with one", () => {
    expect(matchesKindFilter({ kind: "functional" }, null)).toBe(true);
    expect(matchesKindFilter({ kind: null }, null)).toBe(true);
    expect(matchesKindFilter({ kind: "functional" }, "functional")).toBe(true);
    expect(matchesKindFilter({ kind: "non-functional" }, "functional")).toBe(false);
    expect(matchesKindFilter({ kind: "non-functional" }, "non-functional")).toBe(true);
  });

  it("treats a null or absent kind as unclassified, never as functional", () => {
    expect(matchesKindFilter({ kind: null }, "functional")).toBe(false);
    expect(matchesKindFilter({}, "functional")).toBe(false);
    expect(matchesKindFilter({ kind: null }, "unclassified")).toBe(true);
    expect(matchesKindFilter({}, "unclassified")).toBe(true);
    expect(matchesKindFilter({ kind: "functional" }, "unclassified")).toBe(false);
  });
});

describe("RequirementKindBadge", () => {
  it("names a functional requirement", () => {
    render(<RequirementKindBadge kind="functional" nfrCategory={null} />);
    expect(screen.getByTestId("requirement-kind")).toHaveTextContent("Functional");
  });

  it("names a non-functional requirement with its category", () => {
    render(<RequirementKindBadge kind="non-functional" nfrCategory="security" />);
    const badge = screen.getByTestId("requirement-kind");
    expect(badge).toHaveTextContent("Non-functional · security");
    expect(badge).toHaveAttribute("data-kind", "non-functional");
  });

  it("renders nothing for an unclassified requirement", () => {
    const { container } = render(<RequirementKindBadge kind={null} nfrCategory={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("RequirementKindFilter", () => {
  it("marks the active option and reports the one clicked", async () => {
    const onChange = vi.fn();
    render(<RequirementKindFilter value="functional" onChange={onChange} />);
    expect(screen.getByTestId("kind-filter-functional")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("kind-filter-all")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByTestId("kind-filter-non-functional"));
    expect(onChange).toHaveBeenCalledWith("non-functional");
    await userEvent.click(screen.getByTestId("kind-filter-all"));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
