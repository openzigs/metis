import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import {
  SkillsLibraryPanel as AdminSkillsPage,
  rebuildSource,
} from "@/components/library/skills-library-panel";
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
    diff: vi.fn(),
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
const diffMock = vi.mocked(skillsApi.diff);

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

  describe("version diff (#797)", () => {
    const V1 = {
      id: "v1",
      version: "1.0.0",
      contentSha256: "aaaaaaaaaaaaaaaaaaaa",
      createdById: null,
      createdAt: "2026-04-25T00:00:00Z",
    };
    const V2 = { ...V1, id: "v2", version: "1.1.0", contentSha256: "bbbbbbbbbbbbbbbbbbbb" };
    const V3 = { ...V1, id: "v3", version: "1.2.0", contentSha256: "cccccccccccccccccccc" };
    const detail = (v: typeof V1, instructions: string) => ({
      ...v,
      manifest: { name: "scan-deps", version: v.version },
      instructions,
    });

    beforeEach(() => {
      // Newest first, as GET /skills/:id/versions orders them.
      versionsMock.mockResolvedValue({ items: [V3, V2, V1] });
      diffMock.mockImplementation(async (_id: string, left: string, right: string) => {
        const all = {
          v1: detail(V1, "Step one.\nStep two."),
          v2: detail(V2, "Step one.\nStep 2 <b>bold</b>."),
          v3: detail(V3, "Step one.\nStep 2 <b>bold</b>.\nStep three."),
        } as Record<string, ReturnType<typeof detail>>;
        return { left: all[left] ?? null, right: all[right] ?? null };
      });
    });

    async function openVersions() {
      renderPage();
      await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
      fireEvent.click(screen.getAllByRole("button", { name: "Versions" })[0]);
      await screen.findByLabelText("From");
    }

    it("diffs the newest version against the previous one by default", async () => {
      await openVersions();
      const diff = await screen.findByTestId("skill-version-diff");
      expect(diffMock).toHaveBeenCalledWith("s1", "v2", "v3");
      const added = within(diff).getAllByTestId("diff-line-add");
      expect(added.map((l) => l.textContent)).toContain("+Step three.");
      expect(
        within(diff)
          .queryAllByTestId("diff-line-remove")
          .map((l) => l.textContent),
      ).toContain('-version: "1.1.0"');
    });

    it("re-diffs when the user picks two other versions, rendering text safely", async () => {
      await openVersions();
      await screen.findByTestId("skill-version-diff");
      fireEvent.change(screen.getByLabelText("From"), { target: { value: "v1" } });
      fireEvent.change(screen.getByLabelText("To"), { target: { value: "v2" } });
      await waitFor(() => expect(diffMock).toHaveBeenCalledWith("s1", "v1", "v2"));
      const diff = await screen.findByTestId("skill-version-diff");
      await waitFor(() =>
        expect(
          within(diff)
            .getAllByTestId("diff-line-remove")
            .map((l) => l.textContent),
        ).toContain("-Step two."),
      );
      // Markup in the skill body is shown as text, never parsed into elements.
      expect(within(diff).getByText(/Step 2 <b>bold<\/b>\./)).toBeInTheDocument();
      expect(diff.querySelector("b")).toBeNull();
    });

    it("diffs a row against its previous version from the row button", async () => {
      await openVersions();
      await screen.findByTestId("skill-version-diff");
      fireEvent.click(screen.getByRole("button", { name: "Diff v1.1.0 against previous" }));
      await waitFor(() => expect(diffMock).toHaveBeenCalledWith("s1", "v1", "v2"));
    });

    it("says so when the same version is picked twice", async () => {
      await openVersions();
      fireEvent.change(screen.getByLabelText("From"), { target: { value: "v3" } });
      expect(
        await screen.findByText("Pick two different versions to compare."),
      ).toBeInTheDocument();
    });

    it("shows no diff controls for a single version", async () => {
      versionsMock.mockResolvedValue({ items: [V1] });
      renderPage();
      await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
      fireEvent.click(screen.getAllByRole("button", { name: "Versions" })[0]);
      await screen.findByText("v1.0.0");
      expect(screen.queryByLabelText("From")).toBeNull();
      expect(diffMock).not.toHaveBeenCalled();
    });

    it("shows an error when the diff request fails", async () => {
      diffMock.mockRejectedValue(new ApiError(500, "boom"));
      await openVersions();
      expect(await screen.findByText("Failed to load the diff.")).toBeInTheDocument();
    });
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

  // #268 — an AlertDialog replaced window.confirm: the row's Delete only
  // opens the dialog; the dialog's Delete action performs the removal.
  it("deletes a skill after confirming in the AlertDialog", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(removeMock).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(expect.stringContaining("Delete skill "));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("s1"));
  });

  it("does not delete when the AlertDialog is cancelled", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    const row = screen.getByText("Scan Deps").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("edits the source textarea inside the create form", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-skill"));
    const ta = (await screen.findByTestId("skill-source")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "---\nname: edited\n---\nbody" } });
    expect(ta.value).toContain("edited");
  });
});
