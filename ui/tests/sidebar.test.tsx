import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "@/components/layout/sidebar";
import { NAV_ITEMS, NAV_SECTIONS } from "@/lib/navigation";
import { usePathname } from "next/navigation";

const usePathnameMock = vi.mocked(usePathname);

describe("<Sidebar /> — desktop column", () => {
  it("renders every nav item with an accessible link", () => {
    usePathnameMock.mockReturnValue("/dashboard");
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} />);
    for (const item of NAV_ITEMS) {
      // Drawer is closed so each label appears exactly once (desktop column).
      expect(screen.getByRole("link", { name: new RegExp(item.label, "i") })).toBeInTheDocument();
    }
  });

  it("renders the four section headings as non-interactive labels", () => {
    usePathnameMock.mockReturnValue("/dashboard");
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} />);
    for (const section of NAV_SECTIONS) {
      const heading = screen.getByRole("heading", { name: section.label });
      expect(heading).toBeInTheDocument();
      // Heading is a label, not a link.
      expect(heading.tagName).toBe("H2");
    }
  });

  it("wires each grouped list to its section heading via aria-labelledby", () => {
    usePathnameMock.mockReturnValue("/dashboard");
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} />);
    for (const section of NAV_SECTIONS) {
      const heading = screen.getByRole("heading", { name: section.label });
      const list = document.querySelector(`ul[aria-labelledby="${heading.id}"]`);
      expect(list).not.toBeNull();
    }
  });

  it("marks only the active route with aria-current=page", () => {
    usePathnameMock.mockReturnValue("/projects/abc-123");
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} />);
    const projects = screen.getByRole("link", { name: /projects/i });
    expect(projects).toHaveAttribute("aria-current", "page");
    expect(projects).toHaveAttribute("data-active", "true");
    const dashboard = screen.getByRole("link", { name: /dashboard/i });
    expect(dashboard).not.toHaveAttribute("aria-current");
  });

  it("does not render the mobile drawer content while closed (not tabbable)", () => {
    usePathnameMock.mockReturnValue("/dashboard");
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} />);
    // Radix removes the dialog content from the tree entirely when closed —
    // i.e. nothing inside the drawer is reachable by Tab or screen readers.
    expect(screen.queryByTestId("sidebar-drawer")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("<Sidebar /> — mobile drawer (a11y)", () => {
  it("renders as a modal dialog when open", () => {
    usePathnameMock.mockReturnValue("/dashboard");
    render(<Sidebar mobileOpen={true} onMobileClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Primary navigation");
  });

  it("closes via Escape key", async () => {
    usePathnameMock.mockReturnValue("/dashboard");
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Sidebar mobileOpen={true} onMobileClose={onClose} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the built-in close button is activated", async () => {
    usePathnameMock.mockReturnValue("/dashboard");
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Sidebar mobileOpen={true} onMobileClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("invokes onMobileClose when a nav link inside the drawer is clicked", async () => {
    usePathnameMock.mockReturnValue("/dashboard");
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Sidebar mobileOpen={true} onMobileClose={onClose} />);
    // Drawer-rendered link (second occurrence — first is in the desktop column).
    const chatLinks = screen.getAllByRole("link", { name: /chat/i });
    await user.click(chatLinks[chatLinks.length - 1]);
    expect(onClose).toHaveBeenCalled();
  });
});
