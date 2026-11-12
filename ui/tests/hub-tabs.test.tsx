import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { HubTabs } from "@/components/layout/hub-tabs";
import { makeWrapper, TEST_USER } from "./test-utils";

const usePathnameMock = vi.mocked(usePathname);

function renderAt(pathname: string, role: "admin" | "reader" = "admin") {
  usePathnameMock.mockReturnValue(pathname);
  return render(<HubTabs />, {
    wrapper: makeWrapper({ initialUser: { ...TEST_USER, role } }),
  });
}

describe("<HubTabs /> (#27)", () => {
  it("lists the Projects hub pages on a cross-project lookup page", () => {
    renderAt("/repositories");
    const nav = screen.getByRole("navigation", { name: "Projects pages" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "All projects",
      "Products",
      "Documents",
      "Repositories",
      "Databases",
      "Impact analyses",
      "Portfolio coverage",
    ]);
    expect(within(nav).getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/documents",
    );
  });

  it("marks only the current page with aria-current", () => {
    renderAt("/runs/42");
    const nav = screen.getByRole("navigation", { name: "Activity pages" });
    expect(within(nav).getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Tasks" })).not.toHaveAttribute("aria-current");
  });

  it("shows no separate Admin tab, even to admins — Admin is part of Settings (#31)", () => {
    renderAt("/settings/workspaces", "admin");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  // #2332 — Settings keeps one page for a non-admin, so it has no tab bar.
  it("renders no tab bar for a non-admin in Settings, whose Vault and Eval are hidden", () => {
    renderAt("/settings/profile", "reader");
    expect(screen.queryByTestId("hub-tabs")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Vault" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Eval" })).not.toBeInTheDocument();
  });

  // #2332 — Activity keeps only Sessions for a non-admin: no one-tab bar.
  it("renders no tab bar for a non-admin in Activity", () => {
    renderAt("/sessions", "reader");
    expect(screen.queryByTestId("hub-tabs")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tasks" })).not.toBeInTheDocument();
  });

  it("shows an admin the Activity tabs in their order, without Reviews (#2332)", () => {
    renderAt("/sessions", "admin");
    const nav = screen.getByRole("navigation", { name: "Activity pages" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Tasks", "Runs", "Sessions", "Scheduler"]);
  });

  it("shows an admin the Settings tabs", () => {
    renderAt("/vault", "admin");
    const nav = screen.getByRole("navigation", { name: "Settings pages" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Settings", "Vault", "Eval"]);
  });

  it("renders nothing on the Reviews page, a sidebar entry of its own (#2332)", () => {
    renderAt("/reviews", "reader");
    expect(screen.queryByTestId("hub-tabs")).not.toBeInTheDocument();
  });

  it("renders nothing inside a project, which has its own tabs", () => {
    renderAt("/projects/p1/analysis");
    expect(screen.queryByTestId("hub-tabs")).not.toBeInTheDocument();
  });

  it("renders nothing for a single-page hub", () => {
    renderAt("/library");
    expect(screen.queryByTestId("hub-tabs")).not.toBeInTheDocument();
  });

  it("renders nothing outside the navigation", () => {
    renderAt("/somewhere-else");
    expect(screen.queryByTestId("hub-tabs")).not.toBeInTheDocument();
  });
});
