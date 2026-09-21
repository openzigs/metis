/**
 * PausableLiveRegion tests — Issue #662 (WCAG 2.2 SC 2.2.2 Pause, Stop, Hide, A).
 *
 * SC 2.2.2 requires a user control that genuinely halts auto-updating content
 * that starts automatically, runs in parallel with other content and lasts
 * >5s (streaming transcripts, long-running progress logs). These tests lock the
 * shared control's contract in isolation:
 *   - it exposes a keyboard-operable button with an accessible name;
 *   - toggling it FREEZES the region (no DOM mutations from new children) and
 *     flips `aria-live` to "off" so assistive tech stops announcing — i.e. the
 *     pause actually stops updates, it is not a cosmetic toggle;
 *   - resuming re-attaches to the live children and restores polite announces;
 *   - when the region is not auto-updating, no dead control is rendered.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PausableLiveRegion } from "./pausable-live-region";

function Region({ items, active }: { items: string[]; active?: boolean }): React.ReactElement {
  return (
    <PausableLiveRegion label="Chat transcript" role="log" testId="region" active={active}>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </PausableLiveRegion>
  );
}

describe("PausableLiveRegion (#662 — SC 2.2.2 Pause, Stop, Hide)", () => {
  it("renders a keyboard-operable pause control with an accessible name", () => {
    render(<Region items={["A"]} />);
    const control = screen.getByRole("button", { name: "Pause Chat transcript auto-updates" });
    expect(control).toBeInTheDocument();
    // Must be a real <button> so it is inherently keyboard-focusable/operable.
    expect(control.tagName).toBe("BUTTON");
    expect(control).toHaveAttribute("aria-pressed", "false");
  });

  it("exposes the region as a polite live region with the accessible name", () => {
    render(<Region items={["A"]} />);
    const region = screen.getByTestId("region");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("role", "log");
    expect(region).toHaveAttribute("aria-label", "Chat transcript");
    expect(region).toHaveAttribute("data-paused", "false");
  });

  it("passes new children through to the DOM while running (live updates work)", () => {
    const { rerender } = render(<Region items={["A"]} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    rerender(<Region items={["A", "B"]} />);
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("FREEZES the DOM while paused — new children do not mutate the region", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Region items={["A", "B"]} />);
    expect(screen.getByText("B")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Pause Chat transcript/ }));

    // aria-live off + pressed state so SR stops announcing.
    const region = screen.getByTestId("region");
    expect(region).toHaveAttribute("aria-live", "off");
    expect(region).toHaveAttribute("data-paused", "true");
    expect(screen.getByRole("button", { name: /Resume Chat transcript/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // A new streamed item arrives while paused — it must NOT reach the DOM.
    rerender(<Region items={["A", "B", "C"]} />);
    expect(screen.queryByText("C")).not.toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("resumes live updates and restores polite announcements", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Region items={["A", "B"]} />);

    await user.click(screen.getByRole("button", { name: /Pause Chat transcript/ }));
    rerender(<Region items={["A", "B", "C"]} />);
    expect(screen.queryByText("C")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Resume Chat transcript/ }));

    // The frozen content catches up to the latest children on resume.
    expect(screen.getByText("C")).toBeInTheDocument();
    const region = screen.getByTestId("region");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("data-paused", "false");
  });

  it("toggles via the keyboard (focus + Enter) without a pointer", async () => {
    const user = userEvent.setup();
    render(<Region items={["A"]} />);

    await user.tab();
    const control = screen.getByRole("button", { name: /Pause Chat transcript/ });
    expect(control).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByTestId("region")).toHaveAttribute("data-paused", "true");

    await user.keyboard(" ");
    expect(screen.getByTestId("region")).toHaveAttribute("data-paused", "false");
  });

  it("omits the control when the region is not auto-updating (active=false)", () => {
    render(<Region items={["A"]} active={false} />);
    expect(screen.queryByRole("button", { name: /auto-updates/ })).not.toBeInTheDocument();
    // The region still renders its content and announces politely.
    const region = screen.getByTestId("region");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("force-resumes if it becomes inactive while paused (never strands a frozen region)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Region items={["A", "B"]} active />);
    await user.click(screen.getByRole("button", { name: /Pause Chat transcript/ }));
    rerender(<Region items={["A", "B", "C"]} active={false} />);

    // Control gone AND the latest content is shown (not frozen at "B").
    expect(screen.queryByRole("button", { name: /auto-updates/ })).not.toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByTestId("region")).toHaveAttribute("aria-live", "polite");
  });

  it("applies the supplied className and atomic flag to the region", () => {
    render(
      <PausableLiveRegion label="Publish progress log" className="font-mono" atomic testId="pub">
        <ol>
          <li>line 1</li>
        </ol>
      </PausableLiveRegion>,
    );
    const region = screen.getByTestId("pub");
    expect(region).toHaveClass("font-mono");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });
});
