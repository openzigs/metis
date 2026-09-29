/**
 * N6 (#154) — settings-nav registry + persistent settings layout nav.
 * #31 — Settings and Admin are one area, with role-gated admin sections.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import {
  SETTINGS_NAV,
  isAdminOnlySettingsPath,
  isSettingsNavActive,
  visibleSettingsNav,
} from "@/lib/settings-nav";
import SettingsLayout from "@/app/(authed)/settings/layout";
import { makeWrapper, TEST_USER } from "./test-utils";

const usePathnameMock = vi.mocked(usePathname);

function renderAt(pathname: string, role: "admin" | "reader" = "admin") {
  usePathnameMock.mockReturnValue(pathname);
  return render(
    <SettingsLayout>
      <div data-testid="child">content</div>
    </SettingsLayout>,
    { wrapper: makeWrapper({ initialUser: { ...TEST_USER, role } }) },
  );
}

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

describe("admin-only settings sections (#31)", () => {
  it("lists the former Admin pages as admin-only sections", () => {
    const admin = SETTINGS_NAV.filter((i) => i.adminOnly).map((i) => i.href);
    expect(admin).toEqual(["/settings/workspaces", "/settings/auth", "/settings/embeddings"]);
  });

  it("hides admin-only sections from non-admins", () => {
    const hrefs = visibleSettingsNav(false).map((i) => i.href);
    expect(hrefs).not.toContain("/settings/workspaces");
    expect(hrefs).toContain("/settings/usage");
    expect(visibleSettingsNav(true)).toHaveLength(SETTINGS_NAV.length);
  });

  it("recognises an admin-only path, including its sub-pages", () => {
    expect(isAdminOnlySettingsPath("/settings/workspaces")).toBe(true);
    expect(isAdminOnlySettingsPath("/settings/workspaces/ws-1")).toBe(true);
    expect(isAdminOnlySettingsPath("/settings/auth")).toBe(true);
    expect(isAdminOnlySettingsPath("/settings/usage")).toBe(false);
    expect(isAdminOnlySettingsPath("/settings")).toBe(false);
  });

  it("links no section to a retired Admin route", () => {
    for (const item of SETTINGS_NAV) expect(item.href.startsWith("/admin")).toBe(false);
  });
});

describe("<SettingsLayout />", () => {
  it("renders every sub-section for an admin, the admin ones under Administration", () => {
    renderAt("/settings/profile", "admin");
    expect(screen.getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
    for (const item of SETTINGS_NAV) {
      expect(screen.getByRole("link", { name: item.label })).toBeInTheDocument();
    }
    const adminList = screen.getByRole("list", { name: "Administration" });
    expect(adminList).toHaveTextContent("Workspaces");
    expect(adminList).not.toHaveTextContent("Profile");
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("hides the Administration group from a non-admin", () => {
    renderAt("/settings/profile", "reader");
    expect(screen.queryByRole("link", { name: "Workspaces" })).not.toBeInTheDocument();
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Usage & cost" })).toBeInTheDocument();
  });

  it("refuses an admin-only section to a non-admin", () => {
    renderAt("/settings/workspaces/ws-1", "reader");
    expect(screen.getByTestId("settings-admin-required")).toBeInTheDocument();
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
  });

  it("renders an admin-only section for an admin", () => {
    renderAt("/settings/auth", "admin");
    expect(screen.queryByTestId("settings-admin-required")).not.toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("marks the active sub-section with aria-current=page", () => {
    renderAt("/settings/mcp");
    expect(screen.getByRole("link", { name: "MCP servers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Profile" })).not.toHaveAttribute("aria-current");
  });
});
