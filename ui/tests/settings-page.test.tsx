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
import { makeWrapper, TEST_USER } from "./test-utils";

function renderHub(role: "admin" | "reader" = "reader") {
  return render(<SettingsHubPage />, {
    wrapper: makeWrapper({ initialUser: { ...TEST_USER, role } }),
  });
}

describe("<SettingsHubPage />", () => {
  it("renders the hub root with a heading and lead copy", () => {
    renderHub();
    expect(screen.getByTestId("settings-hub-root")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("links to every settings sub-page", () => {
    renderHub();
    const expected: Array<[string, string]> = [
      ["settings-hub-link-profile", "/settings/profile"],
      ["settings-hub-link-appearance", "/settings/appearance"],
      ["settings-hub-link-notifications", "/settings/notifications"],
      ["settings-hub-link-api-keys", "/settings/api-keys"],
      ["settings-hub-link-integrations", "/settings/integrations"],
      ["settings-hub-link-mcp", "/settings/mcp"],
      ["settings-hub-link-skills", "/library?tab=skills"],
      ["settings-hub-link-agents", "/library?tab=agents"],
      ["settings-hub-link-acp", "/settings/acp"],
      ["settings-hub-link-hooks", "/settings/hooks"],
      ["settings-hub-link-triggers", "/settings/triggers"],
      ["settings-hub-link-usage", "/settings/usage"],
    ];
    for (const [testId, href] of expected) {
      const el = screen.getByTestId(testId);
      expect(el).toBeInTheDocument();
      expect(el).toHaveAttribute("href", href);
    }
  });

  it("does not present Vault as a primary settings card (its own page is canonical)", () => {
    renderHub();
    // N5 #153 — Vault/Repositories/Databases have their own pages, not hub cards.
    expect(screen.queryByTestId("settings-hub-link-vault")).not.toBeInTheDocument();
  });

  it("keeps a thin pointer to the canonical Vault surface", () => {
    renderHub();
    const pointer = screen.getByRole("link", { name: "Vault" });
    expect(pointer).toHaveAttribute("href", "/vault");
  });

  it("includes a description for each card", () => {
    renderHub();
    expect(screen.getByText(/Username, display name/)).toBeInTheDocument();
    expect(screen.getByText(/Theme \(light \/ dark \/ system\)/)).toBeInTheDocument();
    expect(screen.getByText(/Channel \+ event preferences/)).toBeInTheDocument();
  });

  it("surfaces one Usage & cost card that still names FinOps", () => {
    renderHub();
    const card = screen.getByTestId("settings-hub-link-usage");
    expect(card).toHaveAttribute("href", "/settings/usage");
    expect(card).toHaveTextContent(/FinOps/);
    expect(screen.queryByTestId("settings-hub-link-finops")).not.toBeInTheDocument();
  });

  // #31 — Settings and Admin are one area; the Admin sections are role-gated.
  it("shows the former Admin sections to system admins", () => {
    renderHub("admin");
    for (const [testId, href] of [
      ["settings-hub-link-workspaces", "/settings/workspaces"],
      ["settings-hub-link-auth", "/settings/auth"],
      ["settings-hub-link-embeddings", "/settings/embeddings"],
    ] as const) {
      expect(screen.getByTestId(testId)).toHaveAttribute("href", href);
    }
  });

  it("hides the former Admin sections from everyone else", () => {
    renderHub("reader");
    expect(screen.queryByTestId("settings-hub-link-workspaces")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-hub-link-auth")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-hub-link-embeddings")).not.toBeInTheDocument();
  });

  it("links no card to a retired Admin route", () => {
    renderHub("admin");
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")?.startsWith("/admin")).toBe(false);
    }
  });

  // Issue #58 — screen-reader audit. Each hub card exposes a level-2 heading so
  // SR users can jump between categories by heading, and the decorative icons
  // are hidden from the accessibility tree.
  it("exposes a single h1 and a level-2 heading per hub card (#58)", () => {
    renderHub();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    for (const name of ["Profile", "Appearance", "Notifications", "MCP servers", "Integrations"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });
});
