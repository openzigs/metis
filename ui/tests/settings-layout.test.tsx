/**
 * N6 (#154) — settings-nav registry + persistent settings layout nav.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { SETTINGS_NAV, isSettingsNavActive } from "@/lib/settings-nav";
import SettingsLayout from "@/app/(authed)/settings/layout";

const usePathnameMock = vi.mocked(usePathname);

describe("isSettingsNavActive", () => {
  it("matches the settings index only exactly", () => {
    expect(isSettingsNavActive("/settings", "/settings")).toBe(true);
    expect(isSettingsNavActive("/settings/profile", "/settings")).toBe(false);
  });
  it("matches sub-section prefixes", () => {
    expect(isSettingsNavActive("/settings/mcp", "/settings/mcp")).toBe(true);
    expect(isSettingsNavActive("/settings/mcp/registry", "/settings/mcp")).toBe(true);
    expect(isSettingsNavActive("/settings/agents", "/settings/mcp")).toBe(false);
  });
});

describe("<SettingsLayout />", () => {
  it("renders a persistent settings nav with every sub-section", () => {
    usePathnameMock.mockReturnValue("/settings/profile");
    render(
      <SettingsLayout>
        <div data-testid="child">content</div>
      </SettingsLayout>,
    );
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav).toBeInTheDocument();
    for (const item of SETTINGS_NAV) {
      expect(screen.getByRole("link", { name: item.label })).toBeInTheDocument();
    }
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("marks the active sub-section with aria-current=page", () => {
    usePathnameMock.mockReturnValue("/settings/mcp");
    render(
      <SettingsLayout>
        <div />
      </SettingsLayout>,
    );
    expect(screen.getByRole("link", { name: "MCP servers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Profile" })).not.toHaveAttribute("aria-current");
  });
});
