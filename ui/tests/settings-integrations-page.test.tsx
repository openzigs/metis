/**
 * Epic #196 / #221 — Settings sub-page: Integrations tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsIntegrationsPage from "@/app/(authed)/settings/integrations/page";

describe("<SettingsIntegrationsPage />", () => {
  it("renders the page root with heading + description", () => {
    render(<SettingsIntegrationsPage />);
    expect(screen.getByTestId("settings-integrations-root")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
  });

  it("links to every integration surface", () => {
    render(<SettingsIntegrationsPage />);
    const expected: Array<[string, string]> = [
      ["settings-integrations-link-repositories", "/repositories"],
      ["settings-integrations-link-databases", "/databases"],
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

  it("renders a card grid container", () => {
    render(<SettingsIntegrationsPage />);
    expect(screen.getByTestId("settings-integrations-grid")).toBeInTheDocument();
  });
});
