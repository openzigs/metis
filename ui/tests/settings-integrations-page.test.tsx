/**
 * Epic #196 / #221 — Settings sub-page: Integrations tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsIntegrationsPage from "@/app/(authed)/settings/integrations/page";
import type { AuthUser } from "@/lib/auth-types";
import { makeWrapper, TEST_USER } from "./test-utils";

function renderPage(role: AuthUser["role"] = "admin") {
  return render(<SettingsIntegrationsPage />, {
    wrapper: makeWrapper({ initialUser: { ...TEST_USER, role } }),
  });
}

describe("<SettingsIntegrationsPage />", () => {
  it("renders the page root with heading + description", () => {
    renderPage();
    expect(screen.getByTestId("settings-integrations-root")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
  });

  it("links an admin to every integration surface", () => {
    renderPage("admin");
    const expected: Array<[string, string]> = [
      // #2353 — one card for both, to the project list (each project's Knowledge tab).
      ["settings-integrations-link-connections", "/projects"],
      ["settings-integrations-link-mcp", "/settings/mcp"],
      ["settings-integrations-link-hooks", "/settings/hooks"],
      ["settings-integrations-link-triggers", "/settings/triggers"],
      ["settings-integrations-link-notifications", "/settings/integrations/notifications"],
      ["settings-integrations-link-teams", "/settings/integrations/teams"],
      ["settings-integrations-link-vault", "/vault"],
    ];
    for (const [testId, href] of expected) {
      const el = screen.getByTestId(testId);
      expect(el).toBeInTheDocument();
      expect(el).toHaveAttribute("href", href);
    }
  });

  // #2332 — no card for a page the shell hides from a non-admin.
  it("links a non-admin to no page hidden from them", () => {
    renderPage("developer");
    for (const hidden of ["mcp", "hooks", "triggers", "vault"]) {
      expect(screen.queryByTestId(`settings-integrations-link-${hidden}`)).not.toBeInTheDocument();
    }
    for (const kept of ["connections", "notifications", "teams"]) {
      expect(screen.getByTestId(`settings-integrations-link-${kept}`)).toBeInTheDocument();
    }
  });

  it("renders a card grid container", () => {
    renderPage();
    expect(screen.getByTestId("settings-integrations-grid")).toBeInTheDocument();
  });
});
