import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  EvaluateRequirementsPanel,
  MAX_EXTRA_INSTRUCTIONS,
} from "@/components/analysis/evaluate-requirements-panel";

/** Controlled-input harness so onChange round-trips like the real page. */
function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <EvaluateRequirementsPanel value={value} onChange={setValue} />;
}

describe("EvaluateRequirementsPanel (#907)", () => {
  it("renders collapsed by default with helper text and an aria-expanded toggle", () => {
    render(<Harness />);
    const toggle = screen.getByTestId("evaluate-requirements-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("evaluate-requirements-textarea")).not.toBeInTheDocument();
    expect(screen.getByText(/Describe new requirements/i)).toBeInTheDocument();
  });

  it("expands and collapses on toggle", () => {
    render(<Harness />);
    const toggle = screen.getByTestId("evaluate-requirements-toggle");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("evaluate-requirements-textarea")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("evaluate-requirements-textarea")).not.toBeInTheDocument();
  });

  it("shows a live character counter against the 4096 cap", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("evaluate-requirements-toggle"));
    const textarea = screen.getByTestId("evaluate-requirements-textarea");
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(screen.getByTestId("evaluate-requirements-counter")).toHaveTextContent(
      `5 / ${MAX_EXTRA_INSTRUCTIONS}`,
    );
  });

  it("clamps input to the maximum length", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("evaluate-requirements-toggle"));
    const textarea = screen.getByTestId("evaluate-requirements-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "a".repeat(MAX_EXTRA_INSTRUCTIONS + 50) } });
    expect(textarea.value.length).toBe(MAX_EXTRA_INSTRUCTIONS);
    expect(screen.getByTestId("evaluate-requirements-counter")).toHaveTextContent(
      `${MAX_EXTRA_INSTRUCTIONS} / ${MAX_EXTRA_INSTRUCTIONS}`,
    );
  });

  it("propagates typed text to onChange", () => {
    const onChange = vi.fn();
    render(<EvaluateRequirementsPanel value="" onChange={onChange} defaultExpanded />);
    fireEvent.change(screen.getByTestId("evaluate-requirements-textarea"), {
      target: { value: "Add SSO" },
    });
    expect(onChange).toHaveBeenCalledWith("Add SSO");
  });
});
