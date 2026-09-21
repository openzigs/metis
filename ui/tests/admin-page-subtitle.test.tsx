/**
 * Issue #430 — the /admin subtitle must describe the sections actually present
 * (Workspaces, SSO & Authentication, MCP servers, Skills, Agents, Embeddings,
 * Usage) and must NOT promise sections that do not exist as their own surface
 * ("secrets").
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminPage from "@/app/(authed)/admin/page";

describe("AdminPage subtitle/section reconciliation (#430)", () => {
  it("subtitle no longer promises a standalone 'secrets' section", () => {
    render(<AdminPage />);
    const subtitle = screen.getByText(/workspaces, sso & authentication/i);
    expect(subtitle.textContent?.toLowerCase()).not.toContain("secrets");
  });

  it("every section named in the subtitle has a matching link in the list", () => {
    render(<AdminPage />);
    // The sections actually rendered as links.
    const links = [
      "Workspaces",
      "SSO & Authentication",
      "MCP servers",
      "Skills library",
      "Agents library",
      "Embedding backends",
      "Usage",
    ];
    for (const name of links) {
      expect(screen.getByRole("link", { name: new RegExp(name, "i") })).toBeInTheDocument();
    }
  });

  it("subtitle mentions the present section themes", () => {
    render(<AdminPage />);
    const subtitle = screen
      .getByText(/workspaces, sso & authentication/i)
      .textContent!.toLowerCase();
    for (const theme of ["workspaces", "sso", "mcp", "skills", "agents", "embeddings", "usage"]) {
      expect(subtitle).toContain(theme);
    }
  });
});
