/**
 * Issue #121 extended — micro-tests for project sub-components with 0% coverage:
 * PrimaryRepoCard, ProjectTabs, and other simple components.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

// ─── PrimaryRepoCard ──────────────────────────────────────────────────────────

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: {
    getPrimary: vi.fn(),
    list: vi.fn(),
  },
}));

import { repoConnectorsApi } from "@/lib/connectors-api";
import { PrimaryRepoCard } from "@/components/projects/primary-repo-card";

const getPrimary = repoConnectorsApi.getPrimary as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getPrimary.mockReset();
});

describe("PrimaryRepoCard", () => {
  it("shows loading state", () => {
    getPrimary.mockImplementationOnce(() => new Promise(() => {}));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PrimaryRepoCard projectId="p1" />
      </Wrapper>,
    );
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it("shows 'No primary repository linked' when no primary repo", async () => {
    getPrimary.mockResolvedValueOnce(null);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PrimaryRepoCard projectId="p1" />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByText(/No primary repository linked/i)).toBeInTheDocument(),
    );
  });

  it("shows repo info when primary repo exists", async () => {
    getPrimary.mockResolvedValueOnce({
      id: "r1",
      ownerOrOrg: "acme",
      repoName: "api",
      provider: "github",
      status: "connected",
      apiBaseUrl: null,
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PrimaryRepoCard projectId="p1" />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText("acme/api")).toBeInTheDocument());
    expect(screen.getByText("connected")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("shows GitHub Enterprise badge and apiBaseUrl", async () => {
    getPrimary.mockResolvedValueOnce({
      id: "r1",
      ownerOrOrg: "corp",
      repoName: "backend",
      provider: "github_enterprise",
      status: "ready",
      apiBaseUrl: "https://git.corp.com/api/v3",
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PrimaryRepoCard projectId="p1" />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText(/GitHub Enterprise/i)).toBeInTheDocument());
    expect(screen.getByText("https://git.corp.com/api/v3")).toBeInTheDocument();
  });
});

// ─── ProjectTabs ──────────────────────────────────────────────────────────────

import { ProjectTabs } from "@/components/projects/project-tabs";

describe("ProjectTabs", () => {
  it("renders project navigation tabs", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectTabs projectId="p1" />
      </Wrapper>,
    );
    expect(screen.getByTestId("project-tabs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Analyze" })).toBeInTheDocument();
    // #28 — the "More" overflow menu is gone.
    expect(screen.queryByRole("button", { name: /more project sections/i })).toBeNull();
  });

  it("marks the active tab based on current pathname (uses usePathname mock)", () => {
    // usePathname is mocked in setup.ts to return "/", here we just verify rendering
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectTabs projectId="p1" />
      </Wrapper>,
    );
    const nav = screen.getByRole("navigation", { name: /Project sections/i });
    expect(nav).toBeInTheDocument();
  });

  it("renders all primary tabs", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectTabs projectId="p1" />
      </Wrapper>,
    );
    for (const name of [
      "Overview",
      "Sources",
      "Analyze",
      "Requirements",
      "Docs",
      "Publish",
      "Code",
    ]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });
});
