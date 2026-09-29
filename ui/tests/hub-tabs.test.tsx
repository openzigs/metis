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

  it("hides the Admin tab from non-admins", () => {
    renderAt("/vault", "reader");
    expect(screen.getByRole("link", { name: "Vault" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
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
