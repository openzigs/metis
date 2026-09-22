/**
 * #29 (epic #26) — the project landing page is the Overview (pipeline status),
 * and the settings form it used to be now lives behind the ⚙ tab.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/projects-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/projects-api")>()),
  projectsApi: { get: vi.fn(), archive: vi.fn() },
  knowledgeApi: { search: vi.fn() },
}));
vi.mock("@/components/projects/pipeline-overview", () => ({
  ProjectPipelineOverview: ({ projectId }: { projectId: string }) => (
    <div data-testid="pipeline-stub">{projectId}</div>
  ),
}));
// The settings cards are unit-tested on their own; here they only need to be
// present (or absent), so each renders a marker.
const { card } = vi.hoisted(() => ({
  card: (name: string) =>
    function Card() {
      return <div data-testid={`card-${name}`} />;
    },
}));
vi.mock("@/components/projects/ai-provider-picker", () => ({ AiProviderPicker: card("provider") }));
vi.mock("@/components/projects/ai-model-picker", () => ({ AiModelPicker: card("model") }));
vi.mock("@/components/projects/primary-repo-card", () => ({ PrimaryRepoCard: card("repo") }));
vi.mock("@/components/projects/safety-settings-card", () => ({
  SafetySettingsCard: card("safety"),
}));
vi.mock("@/components/projects/budget-settings-card", () => ({
  BudgetSettingsCard: card("budget"),
}));
vi.mock("@/components/projects/autopilot-settings-card", () => ({
  AutopilotSettingsCard: card("autopilot"),
}));
vi.mock("@/components/projects/database-aware-analysis-settings-card", () => ({
  DatabaseAwareAnalysisSettingsCard: card("db-aware"),
}));
vi.mock("@/components/projects/sql-lineage-settings-card", () => ({
  SqlLineageSettingsCard: card("sql-lineage"),
}));
vi.mock("@/components/projects/agents-md-card", () => ({ AgentsMdCard: card("agents-md") }));
vi.mock("@/components/projects/custom-agents-enablement-card", () => ({
  CustomAgentsEnablementCard: card("custom-agents"),
}));
vi.mock("@/components/projects/inference-profile-card", () => ({
  InferenceProfileCard: card("inference"),
}));
vi.mock("@/components/projects/quarantine-panel", () => ({ QuarantinePanel: card("quarantine") }));
vi.mock("@/components/projects/chronicle-panel", () => ({ ChroniclePanel: card("chronicle") }));

import ProjectOverviewPage from "@/app/(authed)/projects/[id]/page";
import ProjectSettingsPage from "@/app/(authed)/projects/[id]/settings/page";
import { projectsApi } from "@/lib/projects-api";

const getProject = vi.mocked(projectsApi.get);
const archive = vi.mocked(projectsApi.archive);

const PROJECT = {
  id: "p1",
  name: "Alpha",
  slug: "alpha",
  status: "active",
  description: "The alpha project",
  createdById: "u",
  createdAt: "",
  updatedAt: "",
};

const SETTINGS_CARDS = [
  "provider",
  "model",
  "repo",
  "inference",
  "safety",
  "budget",
  "autopilot",
  "db-aware",
  "sql-lineage",
  "agents-md",
  "custom-agents",
];

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue(PROJECT as never);
});

describe("project Overview page", () => {
  it("shows the pipeline and none of the settings form", async () => {
    render(<ProjectOverviewPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    expect(await screen.findByRole("heading", { level: 1, name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-stub")).toHaveTextContent("p1");
    for (const c of [...SETTINGS_CARDS, "quarantine", "chronicle"]) {
      expect(screen.queryByTestId(`card-${c}`)).toBeNull();
    }
    expect(screen.queryByTestId("archive-button")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });
});

describe("project Settings page (⚙)", () => {
  it("hosts every settings card, quarantine, chronicle and archive", async () => {
    render(<ProjectSettingsPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Project settings" }),
    ).toBeInTheDocument();
    for (const c of [...SETTINGS_CARDS, "quarantine", "chronicle"]) {
      expect(screen.getByTestId(`card-${c}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("model-settings-link")).toHaveAttribute(
      "href",
      "/projects/p1/settings/models",
    );
    // Not an "Overview" page: exactly one project page carries that name.
    expect(screen.queryByText(/overview/i)).toBeNull();
  });

  it("links the project's skills in Library only for project.update holders", async () => {
    const { unmount } = render(<ProjectSettingsPage />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    await screen.findByTestId("card-provider");
    expect(screen.queryByTestId("project-skills-link")).toBeNull();
    unmount();

    render(<ProjectSettingsPage />, {
      wrapper: makeWrapper({ initialUser: { ...TEST_USER, permissions: ["project.update"] } }),
    });
    expect(await screen.findByTestId("project-skills-link")).toHaveAttribute(
      "href",
      "/library?projectId=p1",
    );
  });

  it("archives an active project and hides Archive once archived", async () => {
    archive.mockResolvedValue(undefined as never);
    const { unmount } = render(<ProjectSettingsPage />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    fireEvent.click(await screen.findByTestId("archive-button"));
    await waitFor(() => expect(archive).toHaveBeenCalled());
    unmount();

    getProject.mockResolvedValue({ ...PROJECT, status: "archived" } as never);
    render(<ProjectSettingsPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await screen.findByTestId("card-provider");
    expect(screen.queryByTestId("archive-button")).toBeNull();
  });

  it("shows an error when the project cannot be loaded", async () => {
    getProject.mockRejectedValue(new Error("boom"));
    render(<ProjectSettingsPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    expect(await screen.findByText("Project not found.")).toBeInTheDocument();
  });
});
