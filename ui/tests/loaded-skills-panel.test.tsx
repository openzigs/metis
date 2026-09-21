import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { LoadedSkillsPanel } from "@/components/chat/loaded-skills-panel";
import { libraryApi } from "@/lib/library-api";
import { apiFetch } from "@/lib/api-client";

// #468: the panel now sources its "Available" list from the resolved-available
// endpoint (runtime gate), not the raw explicit allowlist.
vi.mock("@/lib/library-api", () => ({
  libraryApi: { projectAvailableSkills: vi.fn() },
}));
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

const availableSkillsMock = vi.mocked(libraryApi.projectAvailableSkills);
const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  availableSkillsMock.mockResolvedValue({
    items: [{ skillId: "s1", skillKey: "scan-deps", name: "Scan deps", description: "" }],
  });
  // Default: the GET-list call returns one already-loaded skill.
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/skills") && !url.includes("?")) {
      return {
        items: [
          {
            id: "s3",
            key: "already-loaded",
            name: "Already loaded",
            description: "",
            loadedAt: "2025-01-01T00:00:00Z",
          },
        ],
      } as unknown as never;
    }
    return { ok: true } as unknown as never;
  });
});
afterEach(() => vi.restoreAllMocks());

function renderPanel(opts: { sessionId?: string | null; projectId?: string | null } = {}) {
  const sessionId = "sessionId" in opts ? (opts.sessionId ?? null) : "sess-1";
  const projectId = "projectId" in opts ? (opts.projectId ?? null) : "p-1";
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <LoadedSkillsPanel sessionId={sessionId} projectId={projectId} />
    </Wrapper>,
  );
}

describe("<LoadedSkillsPanel />", () => {
  it("prompts the user to start a session when sessionId is null", () => {
    renderPanel({ sessionId: null });
    expect(screen.getByText(/Start a chat session/i)).toBeInTheDocument();
  });

  it("renders the loaded skill list with order numbers", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Already loaded")).toBeInTheDocument());
    expect(screen.getByLabelText("Order 1")).toBeInTheDocument();
  });

  it("renders the resolved available skills (name + key)", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("available-skills-list")).toBeInTheDocument());
    expect(screen.getByText("Scan deps")).toBeInTheDocument();
    expect(screen.getByText("scan-deps")).toBeInTheDocument();
  });

  it("posts a load mutation when the Load button is clicked", async () => {
    renderPanel();
    const btn = await screen.findByTestId("load-skill-scan-deps");
    fireEvent.click(btn);
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/ai/sessions/sess-1/skills",
        expect.objectContaining({ method: "POST", body: { skillId: "s1" } }),
      ),
    );
  });

  it("exposes an accessible label per Load button", async () => {
    renderPanel();
    const btn = await screen.findByLabelText("Load skill scan-deps");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("data-testid", "load-skill-scan-deps");
  });

  it("shows per-button loading state without affecting siblings", async () => {
    availableSkillsMock.mockResolvedValue({
      items: [
        { skillId: "s1", skillKey: "scan-deps", name: "Scan deps", description: "" },
        { skillId: "s4", skillKey: "other-skill", name: "Other skill", description: "" },
      ],
    });
    // Hold the POST open so we can assert the in-flight UI.
    let resolvePost: ((v: unknown) => void) | undefined;
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/skills") && init?.method === "POST") {
        return new Promise((r) => {
          resolvePost = r;
        }) as unknown as never;
      }
      if (url.endsWith("/skills")) {
        return { items: [] } as unknown as never;
      }
      return { ok: true } as unknown as never;
    });
    renderPanel();
    const btn = await screen.findByTestId("load-skill-scan-deps");
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveTextContent(/Loading/));
    expect(btn).toHaveAttribute("aria-label", "Loading skill scan-deps");
    const sibling = screen.getByTestId("load-skill-other-skill");
    expect(sibling).toHaveAttribute("aria-label", "Load skill other-skill");
    expect(sibling).toBeDisabled();
    expect(sibling).toHaveTextContent("Load");
    resolvePost?.({ alreadyLoaded: false, loadedSkillIds: ["s1"], skill: {} });
  });

  it("shows an empty-available message when no skills are available", async () => {
    availableSkillsMock.mockResolvedValue({ items: [] });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/No skills available for this project/i)).toBeInTheDocument(),
    );
  });

  it("explains it needs a project when projectId is null", async () => {
    renderPanel({ projectId: null });
    await waitFor(() =>
      expect(screen.getByText(/Open a project to load skills/i)).toBeInTheDocument(),
    );
  });
});
