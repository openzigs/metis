/**
 * N6 (#154) — settings-nav registry + persistent settings layout nav.
 * #31 — Settings and Admin are one area, with role-gated admin sections.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

function renderAt(pathname: string, role: "admin" | "developer" | "reader" = "admin") {
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
  it("lists the system-admin and developer pages as admin-only sections (#2332)", () => {
    const admin = SETTINGS_NAV.filter((i) => i.adminOnly).map((i) => i.href);
    expect(admin).toEqual([
      "/settings/api-keys",
      "/settings/mcp",
      "/settings/acp",
      "/settings/hooks",
      "/settings/triggers",
      "/settings/auth",
      "/settings/embeddings",
    ]);
  });

  it("files only SSO and Embeddings under Administration (#2332)", () => {
    const grouped = SETTINGS_NAV.filter((i) => i.administration).map((i) => i.href);
    expect(grouped).toEqual(["/settings/auth", "/settings/embeddings"]);
    for (const i of SETTINGS_NAV) if (i.administration) expect(i.adminOnly).toBe(true);
  });

  it("hides MCP servers, ACP tokens, Hooks, Triggers and Configuration from a non-admin (#2332)", () => {
    const labels = visibleSettingsNav(false).map((i) => i.label);
    for (const hidden of ["MCP servers", "ACP tokens", "Hooks", "Triggers", "Configuration"]) {
      expect(labels).not.toContain(hidden);
    }
    expect(labels).toEqual([
      "Overview",
      "Profile",
      "Appearance",
      "Notifications",
      "Integrations",
      "Usage & cost",
      "Workspaces",
    ]);
  });

  it("hides admin-only sections from non-admins", () => {
    const hrefs = visibleSettingsNav(false).map((i) => i.href);
    expect(hrefs).not.toContain("/settings/auth");
    expect(hrefs).toContain("/settings/usage");
    expect(visibleSettingsNav(true)).toHaveLength(SETTINGS_NAV.length);
  });

  // Workspaces are gated by workspace membership role on the server
  // (requireWorkspaceRole), and any signed-in user may create one — so the
  // section is not a system-admin section.
  it("keeps Workspaces open to users who are not system admins", () => {
    expect(visibleSettingsNav(false).map((i) => i.href)).toContain("/settings/workspaces");
    expect(isAdminOnlySettingsPath("/settings/workspaces")).toBe(false);
    expect(isAdminOnlySettingsPath("/settings/workspaces/ws-1")).toBe(false);
  });

  it("recognises an admin-only path, including its sub-pages", () => {
    expect(isAdminOnlySettingsPath("/settings/auth")).toBe(true);
    expect(isAdminOnlySettingsPath("/settings/embeddings/models")).toBe(true);
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
    expect(adminList).toHaveTextContent("SSO & authentication");
    expect(adminList).not.toHaveTextContent("Workspaces");
    expect(adminList).not.toHaveTextContent("Profile");
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  // #2332 — hiding the developer sections from non-admins moves nothing for an admin.
  it("keeps an admin's sections in the order they had", () => {
    renderAt("/settings/profile", "admin");
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(SETTINGS_NAV.map((i) => i.label));
    const adminList = screen.getByRole("list", { name: "Administration" });
    expect(
      within(adminList)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["SSO & authentication", "Embeddings"]);
  });

  it("shows a non-admin no developer section (#2332)", () => {
    renderAt("/settings/profile", "reader");
    for (const hidden of ["MCP servers", "ACP tokens", "Hooks", "Triggers", "Configuration"]) {
      expect(screen.queryByRole("link", { name: hidden })).not.toBeInTheDocument();
    }
  });

  it.each([
    "/settings/mcp",
    "/settings/acp",
    "/settings/hooks",
    "/settings/triggers",
    "/settings/api-keys",
  ])("refuses %s to a non-admin with a way back (#2332)", (path) => {
    renderAt(path, "developer");
    const refusal = screen.getByTestId("settings-admin-required");
    expect(refusal).toHaveTextContent("You don't have access to this page");
    expect(within(refusal).getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
  });

  it("hides the Administration group from a non-admin", () => {
    renderAt("/settings/profile", "reader");
    expect(screen.queryByRole("link", { name: "SSO & authentication" })).not.toBeInTheDocument();
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Usage & cost" })).toBeInTheDocument();
  });

  it("refuses an admin-only section to a non-admin", () => {
    renderAt("/settings/auth", "reader");
    expect(screen.getByTestId("settings-admin-required")).toBeInTheDocument();
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();
  });

  // The header switcher's "Create workspace" routes here for every user.
  it("renders workspace settings for a workspace owner who is not a system admin", () => {
    renderAt("/settings/workspaces/ws-1", "reader");
    expect(screen.queryByTestId("settings-admin-required")).not.toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workspaces" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders neither an admin-only page nor the refusal while auth is loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    try {
      usePathnameMock.mockReturnValue("/settings/auth");
      render(
        <SettingsLayout>
          <div data-testid="child">content</div>
        </SettingsLayout>,
        { wrapper: makeWrapper({ initialUser: null }) },
      );
      expect(screen.queryByTestId("child")).not.toBeInTheDocument();
      expect(screen.queryByTestId("settings-admin-required")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
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
