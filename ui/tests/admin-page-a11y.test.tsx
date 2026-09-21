/**
 * Issue #58 — screen-reader audit for the Admin hub page.
 *
 * The Admin page is coverage-excluded (static wrapper around PlaceholderPage +
 * a link list), but its heading hierarchy and link names are an SR-audit
 * acceptance criterion. It must expose exactly one top-level heading, a
 * level-2 "Sections" heading below it (no skipped levels), and every admin
 * sub-surface must be reachable as a named link.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminPage from "@/app/(authed)/admin/page";

describe("AdminPage — screen-reader affordances (#58)", () => {
  it("exposes exactly one h1 and a level-2 Sections heading", () => {
    render(<AdminPage />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Admin");
    expect(screen.getByRole("heading", { level: 2, name: "Sections" })).toBeInTheDocument();
  });

  it("names every admin sub-surface link", () => {
    render(<AdminPage />);
    const expected: Array<[RegExp, string]> = [
      [/Workspaces/, "/admin/workspaces"],
      [/SSO & Authentication/, "/admin/auth"],
      [/MCP servers/, "/admin/mcp"],
      [/Skills library/, "/admin/skills"],
      [/Agents library/, "/admin/agents"],
      [/Embedding backends/, "/admin/embeddings"],
      [/Usage/, "/admin/usage"],
    ];
    for (const [name, href] of expected) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });
});
