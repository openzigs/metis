/**
 * HelpMenu component tests — Issue #661 (WCAG 2.2 SC 3.2.6 Consistent Help, AA).
 *
 * The header exposes a persistent Help affordance whose consistent relative
 * placement across pages is what moves 3.2.6 from Not Applicable → Supports.
 * These tests lock the affordance's own accessibility contract in isolation:
 *   - the trigger is a keyboard-operable button with the accessible name "Help";
 *   - activating it opens a Radix Dialog that is labelled (accessible name) and
 *     described;
 *   - the dialog offers at least one SC 3.2.6-allowed help mechanism — a
 *     self-help/documentation link and a contact mechanism (issue tracker).
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HelpMenu } from "./help-menu";

describe("HelpMenu (#661 — SC 3.2.6 Consistent Help)", () => {
  it("renders a button trigger with the accessible name 'Help'", () => {
    render(<HelpMenu />);
    const trigger = screen.getByRole("button", { name: "Help" });
    expect(trigger).toBeInTheDocument();
    // Icon-only trigger must not leak the SVG to the a11y tree as the name.
    expect(trigger).toHaveAttribute("aria-label", "Help");
  });

  it("carries a stable test id so e2e can assert its header position", () => {
    render(<HelpMenu />);
    expect(screen.getByTestId("help-trigger")).toBeInTheDocument();
  });

  it("opens a labelled, described dialog when the trigger is activated", async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);

    // Closed by default.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Help" }));

    const dialog = await screen.findByRole("dialog", { name: /help/i });
    expect(dialog).toBeInTheDocument();
    // Described by the dialog description (aria-describedby wired by Radix).
    expect(dialog).toHaveAccessibleDescription();
  });

  it("is keyboard-operable: Enter on the focused trigger opens the dialog", async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);

    await user.tab();
    const trigger = screen.getByRole("button", { name: "Help" });
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: /help/i })).toBeInTheDocument();
  });

  it("offers SC 3.2.6 help mechanisms: a documentation link and a contact mechanism", async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await user.click(screen.getByRole("button", { name: "Help" }));

    const dialog = await screen.findByRole("dialog", { name: /help/i });

    // Self-help / documentation link.
    const docs = within(dialog).getByRole("link", { name: /user guide|documentation/i });
    expect(docs).toHaveAttribute("href");
    // External links must be safe (OWASP — no reverse tabnabbing).
    expect(docs).toHaveAttribute("rel", expect.stringContaining("noopener"));

    // Contact mechanism (issue tracker / support).
    const contact = within(dialog).getByRole("link", { name: /support|issue|contact/i });
    expect(contact).toHaveAttribute("href");
  });

  it("closes on Escape, restoring the Radix dialog contract", async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(await screen.findByRole("dialog", { name: /help/i })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
