import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import AdminSkillsPage, { rebuildSource } from "@/app/(authed)/admin/skills/page";
import { skillsApi, type SkillDetail, type SkillSummary } from "@/lib/library-api";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/library-api", () => ({
  skillsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    archive: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    versions: vi.fn(),
  },
}));

const listMock = vi.mocked(skillsApi.list);
const getMock = vi.mocked(skillsApi.get);
const createMock = vi.mocked(skillsApi.create);
const updateMock = vi.mocked(skillsApi.update);
const removeMock = vi.mocked(skillsApi.remove);
const archiveMock = vi.mocked(skillsApi.archive);
const enableMock = vi.mocked(skillsApi.enable);
const disableMock = vi.mocked(skillsApi.disable);
const versionsMock = vi.mocked(skillsApi.versions);

function makeSummary(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "s1",
    key: "scan-deps",
    name: "Scan Deps",
    description: "Scans deps for CVEs",
    version: "1.0.0",
    tools: [],
    resources: [],
    tags: ["security"],
    enabled: true,
    archived: false,
    source: "inline",
    contentSha256: null,
    createdById: null,
    createdAt: "2026-04-25T00:00:00Z",
    updatedAt: "2026-04-25T00:00:00Z",
    ...over,
  };
}

function makeDetail(over: Partial<SkillDetail> = {}): SkillDetail {
  return {
    ...makeSummary(),
    instructions: "Body of the skill.",
    manifest: { name: "scan-deps", description: "x", version: "1.0.0", tags: ["security"] },
    ...over,
  } as SkillDetail;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [makeSummary()] });
  getMock.mockResolvedValue(makeDetail());
  createMock.mockResolvedValue(makeDetail());
  updateMock.mockResolvedValue(makeDetail());
  removeMock.mockResolvedValue(undefined);
  archiveMock.mockResolvedValue(makeDetail({ archived: true }));
  enableMock.mockResolvedValue(makeDetail({ enabled: true }));
  disableMock.mockResolvedValue(makeDetail({ enabled: false }));
  versionsMock.mockResolvedValue({
    items: [
      {
        id: "v1",
        version: "1.0.0",
        contentSha256: "abcdef0123456789abcdef",
        createdById: null,
        createdAt: "2026-04-25T00:00:00Z",
      },
    ],
  });
});

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(
    <Wrapper>
      <AdminSkillsPage />
    </Wrapper>,
  );
}

describe("rebuildSource", () => {
  it("emits canonical YAML frontmatter and the body", () => {
    const out = rebuildSource(
      makeDetail({
        manifest: {
          name: "x",
          description: "y",
          version: "1.0.0",
          tags: ["a", "b"],
          empty: null,
          undef: undefined,
          count: 3,
        },
        instructions: "BODY",
      }),
    );
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain('name: "x"');
    expect(out).toContain('tags: ["a","b"]');
    expect(out).toContain("count: 3");
    expect(out).not.toContain("empty:");
    expect(out).not.toContain("undef:");
    expect(out.endsWith("BODY")).toBe(true);
  });
});

describe("<AdminSkillsPage />", () => {
  it("shows the loading row, then a row per skill", async () => {
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    expect(screen.getByText("scan-deps")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();
    expect(screen.getByText("enabled")).toBeInTheDocument();
  });

  it("shows the empty state when no skills match", async () => {
    listMock.mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("No skills match.")).toBeInTheDocument());
  });

  it("filters via the search input and the include-archived checkbox", async () => {
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("skills-search"), { target: { value: "scan" } });
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ q: "scan" }));
    fireEvent.click(screen.getByLabelText("Include archived"));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ q: "scan", includeArchived: "1" }));
  });

  it("opens and submits the create dialog", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-skill"));
    expect(await screen.findByText("Create skill")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("skill-save"));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
  });

  it("renders an error alert when create fails", async () => {
    createMock.mockRejectedValue(new ApiError(400, "nope", "BAD"));
    renderPage();
    fireEvent.click(screen.getByTestId("new-skill"));
    await screen.findByText("Create skill");
    fireEvent.click(screen.getByTestId("skill-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });

  it("falls back to a generic error message on non-ApiError failures", async () => {
    createMock.mockRejectedValue(new Error("boom"));
    renderPage();
    fireEvent.click(screen.getByTestId("new-skill"));
    await screen.findByText("Create skill");
    fireEvent.click(screen.getByTestId("skill-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  });

  it("cancels out of the create dialog", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-skill"));
    await screen.findByText("Create skill");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Create skill")).not.toBeInTheDocument());
  });

  it("opens the edit dialog and saves changes", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("s1"));
    expect(await screen.findByText(/Edit skill scan-deps/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("skill-save"));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
  });

  it("shows an error message if loading the edit detail fails", async () => {
    getMock.mockRejectedValue(new Error("nope"));
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(await screen.findByText("Failed to load skill.")).toBeInTheDocument();
  });

  it("opens the versions dialog and lists versions", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Versions" })[0]);
    await waitFor(() => expect(versionsMock).toHaveBeenCalledWith("s1"));
    expect(await screen.findByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByText(/sha256:abcdef012345/)).toBeInTheDocument();
  });

  it("renders the empty versions state", async () => {
    versionsMock.mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Versions" })[0]);
    expect(await screen.findByText("No versions yet.")).toBeInTheDocument();
  });

  it("toggles enable/disable for a skill", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(disableMock).toHaveBeenCalledWith("s1"));
  });

  it("calls enable when the skill is currently disabled", async () => {
    listMock.mockResolvedValue({ items: [makeSummary({ enabled: false })] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(enableMock).toHaveBeenCalledWith("s1"));
  });

  it("archives a skill", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith("s1"));
  });

  it("hides the archive button on already-archived rows", async () => {
    listMock.mockResolvedValue({ items: [makeSummary({ archived: true, enabled: false })] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(within(row).getByText("archived")).toBeInTheDocument();
  });

  it("renders the disabled state pill", async () => {
    listMock.mockResolvedValue({ items: [makeSummary({ enabled: false })] });
    renderPage();
    await waitFor(() => expect(screen.getByText("disabled")).toBeInTheDocument());
  });

  it("renders the em-dash when there are no tags", async () => {
    listMock.mockResolvedValue({ items: [makeSummary({ tags: [] })] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("deletes a skill after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("s1"));
    confirmSpy.mockRestore();
  });

  it("does not delete when confirm is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(removeMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("edits the source textarea inside the create form", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-skill"));
    const ta = (await screen.findByTestId("skill-source")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "---\nname: edited\n---\nbody" } });
    expect(ta.value).toContain("edited");
  });
});
