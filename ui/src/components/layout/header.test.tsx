/**
 * Header control-order tests — Issue #661 (WCAG 2.2 SC 3.2.6 Consistent Help).
 *
 * SC 3.2.6 is satisfied by placing the Help affordance in an *identical relative
 * location* on every page. In this app the global header is rendered once by the
 * app shell on all authenticated routes, so the single guarantee that keeps the
 * criterion "Supports" is the relative order of the right-aligned control
 * cluster. This test locks that order so it cannot silently regress:
 *
 *   ActiveJobsIndicator → NotificationsDrawer → ThemeToggle → Help → UserMenu
 *
 * The sibling controls are stubbed to identifiable markers so the assertion is
 * about *position*, not their internal behaviour (covered by their own suites).
 * The real HelpMenu is rendered so its accessible name is exercised in place.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./breadcrumbs", () => ({ Breadcrumbs: () => <nav data-testid="breadcrumbs" /> }));
vi.mock("./theme-toggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));
vi.mock("./user-menu", () => ({ UserMenu: () => <div data-testid="user-menu" /> }));
vi.mock("@/components/notifications/notifications-drawer", () => ({
  NotificationsDrawer: () => <div data-testid="notifications-drawer" />,
}));
vi.mock("@/components/realtime/active-jobs-indicator", () => ({
  ActiveJobsIndicator: () => <div data-testid="active-jobs" />,
}));

import { Header } from "./header";

/**
 * Asserts the given test ids appear in the document in exactly this order.
 * `compareDocumentPosition` is depth-agnostic, so it holds even though the
 * Help trigger is nested one level deeper (inside its Dialog trigger) than the
 * sibling marker stubs.
 */
function expectDomOrder(...testIds: string[]): void {
  const nodes = testIds.map((id) => screen.getByTestId(id));
  for (let i = 0; i < nodes.length - 1; i++) {
    const following =
      nodes[i].compareDocumentPosition(nodes[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(following, `${testIds[i]} should precede ${testIds[i + 1]}`).toBeTruthy();
  }
}

describe("Header control order (#661)", () => {
  it("renders the Help affordance in the right-aligned control cluster", () => {
    render(<Header onMenuClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Help" })).toBeInTheDocument();
    expect(screen.getByTestId("help-trigger")).toBeInTheDocument();
  });

  it("places Help immediately between the theme toggle and the user menu", () => {
    render(<Header onMenuClick={() => {}} />);

    const theme = screen.getByTestId("theme-toggle");
    const help = screen.getByTestId("help-trigger");
    const user = screen.getByTestId("user-menu");

    // Theme toggle precedes Help precedes the user menu in DOM order.
    expect(theme.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the full cluster order Jobs → Notifications → Theme → Help → User", () => {
    render(<Header onMenuClick={() => {}} />);
    expectDomOrder(
      "active-jobs",
      "notifications-drawer",
      "theme-toggle",
      "help-trigger",
      "user-menu",
    );
  });
});
