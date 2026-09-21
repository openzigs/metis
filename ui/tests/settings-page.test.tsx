/**
 * Epic #196 / #220 — Settings hub navigation tests.
 *
 * The original `settings/page.tsx` has been split into sub-pages; the hub
 * is now a navigation index. These tests cover the hub itself; the sub-
 * pages have their own dedicated test files.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsHubPage from "@/app/(authed)/settings/page";

describe("<SettingsHubPage />", () => {
  it("renders the hub root with a heading and lead copy", () => {
    render(<SettingsHubPage />);
    expect(screen.getByTestId("settings-hub-root")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("links to every settings sub-page", () => {
    render(<SettingsHubPage />);
    const expected: Array<[string, string]> = [
      ["settings-hub-link-profile", "/settings/profile"],
      ["settings-hub-link-appearance", "/settings/appearance"],
      ["settings-hub-link-notifications", "/settings/notifications"],
      ["settings-hub-link-api-keys", "/settings/api-keys"],
      ["settings-hub-link-integrations", "/settings/integrations"],
      ["settings-hub-link-mcp", "/settings/mcp"],
      ["settings-hub-link-agents", "/settings/agents"],
      ["settings-hub-link-acp", "/settings/acp"],
      ["settings-hub-link-hooks", "/settings/hooks"],
      ["settings-hub-link-triggers", "/settings/triggers"],
      ["settings-hub-link-finops", "/admin/workspaces"],
    ];
    for (const [testId, href] of expected) {
      const el = screen.getByTestId(testId);
      expect(el).toBeInTheDocument();
      expect(el).toHaveAttribute("href", href);
    }
  });

  it("does not present Vault as a primary settings card (sidebar is canonical)", () => {
    render(<SettingsHubPage />);
    // N5 #153 — Vault/Repositories/Databases live in the sidebar, not the hub.
    expect(screen.queryByTestId("settings-hub-link-vault")).not.toBeInTheDocument();
  });

  it("keeps a thin pointer to the canonical Vault surface", () => {
    render(<SettingsHubPage />);
    const pointer = screen.getByRole("link", { name: "Vault" });
    expect(pointer).toHaveAttribute("href", "/vault");
  });

  it("includes a description for each card", () => {
    render(<SettingsHubPage />);
    expect(screen.getByText(/Username, display name/)).toBeInTheDocument();
    expect(screen.getByText(/Theme \(light \/ dark \/ system\)/)).toBeInTheDocument();
    expect(screen.getByText(/Channel \+ event preferences/)).toBeInTheDocument();
  });

  it("surfaces a FinOps card that explains the jargon and links to the workspace list", () => {
    render(<SettingsHubPage />);
    const card = screen.getByTestId("settings-hub-link-finops");
    expect(card).toHaveAttribute("href", "/admin/workspaces");
    expect(card).toHaveTextContent("FinOps");
    expect(screen.getByText(/cost & budget tracking/i)).toBeInTheDocument();
  });

  // Issue #58 — screen-reader audit. Each hub card exposes a level-2 heading so
  // SR users can jump between categories by heading, and the decorative icons
  // are hidden from the accessibility tree.
  it("exposes a single h1 and a level-2 heading per hub card (#58)", () => {
    render(<SettingsHubPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    for (const name of ["Profile", "Appearance", "Notifications", "MCP servers", "Integrations"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });
});
