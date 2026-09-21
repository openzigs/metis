/**
 * Issue #1232 — finding bodies arrive as ~1000-character single paragraphs with
 * zero newlines, eight in a row. Markdown rendering alone changes nothing when
 * there is no structure to render, so the load-bearing fix is clamp + expand.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingBody, CLAMP_THRESHOLD_CHARS } from "./FindingBody";

const LONG = "The reconciliation manager only supports LTL and FTL shipment types. ".repeat(20);
const SHORT = "Short body.";

describe("FindingBody (#1232)", () => {
  it("clamps a long body and offers an accessible expand control", () => {
    render(<FindingBody body={LONG} />);

    const toggle = screen.getByRole("button", { name: /show more/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("finding-body")).toHaveAttribute("data-expanded", "false");
  });

  it("toggles the clamp on expand and back on collapse", async () => {
    const user = userEvent.setup();
    render(<FindingBody body={LONG} />);

    await user.click(screen.getByRole("button", { name: /show more/i }));

    const expanded = screen.getByRole("button", { name: /show less/i });
    expect(expanded).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("finding-body")).toHaveAttribute("data-expanded", "true");

    await user.click(expanded);

    expect(screen.getByRole("button", { name: /show more/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByTestId("finding-body")).toHaveAttribute("data-expanded", "false");
  });

  it("points the toggle at the body it controls", () => {
    render(<FindingBody body={LONG} />);

    const controls = screen
      .getByRole("button", { name: /show more/i })
      .getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(screen.getByTestId("finding-body")).toHaveAttribute("id", controls as string);
  });

  it("keeps the full body text in the DOM while clamped, so it stays searchable", () => {
    render(<FindingBody body={LONG} />);

    expect(screen.getByTestId("finding-body")).toHaveTextContent(/LTL and FTL shipment types/);
    expect(screen.getByTestId("finding-body").textContent).toHaveLength(LONG.trim().length);
  });

  it("constrains the body to a readable measure rather than the full container width", () => {
    render(<FindingBody body={LONG} />);

    expect(screen.getByTestId("finding-body").className).toMatch(/max-w-/);
  });

  it("renders a short body with no toggle at all", () => {
    render(<FindingBody body={SHORT} />);

    expect(screen.getByTestId("finding-body")).toHaveTextContent(SHORT);
    expect(screen.queryByRole("button", { name: /show (more|less)/i })).not.toBeInTheDocument();
    expect(SHORT.length).toBeLessThan(CLAMP_THRESHOLD_CHARS);
  });

  it("renders nothing for an empty body", () => {
    const { container } = render(<FindingBody body="   " />);

    expect(container).toBeEmptyDOMElement();
  });
});
