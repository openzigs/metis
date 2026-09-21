/**
 * Issue #1112 (from #1101) — drop point 3: the free-text box used to cut a long
 * paste at the input limit with nothing but a character counter to hint at it.
 * A counter reading "4096 / 4096" looks the same whether or not anything was
 * lost, so the panel must SAY it cut the text.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MAX_EXTRA_INSTRUCTIONS } from "@metis/shared";
import { EvaluateRequirementsPanel } from "./evaluate-requirements-panel";

function typeInto(value: string, onChange = vi.fn()): typeof onChange {
  render(<EvaluateRequirementsPanel value="" onChange={onChange} defaultExpanded />);
  fireEvent.change(screen.getByTestId("evaluate-requirements-textarea"), { target: { value } });
  return onChange;
}

describe("EvaluateRequirementsPanel disclosure", () => {
  it("starts collapsed and reveals the textarea when toggled", () => {
    render(<EvaluateRequirementsPanel value="" onChange={vi.fn()} />);
    expect(screen.queryByTestId("evaluate-requirements-textarea")).toBeNull();

    fireEvent.click(screen.getByTestId("evaluate-requirements-toggle"));
    expect(screen.getByTestId("evaluate-requirements-textarea")).toBeInTheDocument();
    expect(screen.getByTestId("evaluate-requirements-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("keeps the character counter alongside the truncation notice", () => {
    render(<EvaluateRequirementsPanel value="abc" onChange={vi.fn()} defaultExpanded />);
    expect(screen.getByTestId("evaluate-requirements-counter")).toHaveTextContent(
      `3 / ${MAX_EXTRA_INSTRUCTIONS}`,
    );
  });
});

describe("EvaluateRequirementsPanel truncation notice", () => {
  it("says nothing about truncation for text under the limit", () => {
    typeInto("Customers must be able to view their order history.");
    expect(screen.queryByTestId("evaluate-requirements-truncated")).toBeNull();
  });

  it("states that the paste was cut, and by how much, when it exceeds the limit", () => {
    typeInto("x".repeat(MAX_EXTRA_INSTRUCTIONS + 25));

    const notice = screen.getByTestId("evaluate-requirements-truncated");
    expect(notice).toHaveTextContent(`cut at ${MAX_EXTRA_INSTRUCTIONS} characters`);
    expect(notice).toHaveTextContent("last 25 characters were removed");
    expect(notice).toHaveTextContent("will not be analyzed");
  });

  it("still clamps the value it hands upstream to the limit", () => {
    const onChange = typeInto("x".repeat(MAX_EXTRA_INSTRUCTIONS + 25));
    expect(onChange).toHaveBeenCalledWith("x".repeat(MAX_EXTRA_INSTRUCTIONS));
  });

  it("clears the notice once the user shortens the text", () => {
    const onChange = vi.fn();
    render(<EvaluateRequirementsPanel value="" onChange={onChange} defaultExpanded />);
    const textarea = screen.getByTestId("evaluate-requirements-textarea");

    fireEvent.change(textarea, { target: { value: "y".repeat(MAX_EXTRA_INSTRUCTIONS + 1) } });
    expect(screen.getByTestId("evaluate-requirements-truncated")).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "short" } });
    expect(screen.queryByTestId("evaluate-requirements-truncated")).toBeNull();
  });
});
