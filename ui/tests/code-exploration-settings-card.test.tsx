/**
 * #2567 — the analysis depth card (Thorough / Fast / platform default).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import {
  ANALYSIS_DEPTH_OPTIONS,
  CodeExplorationSettingsCard,
} from "@/components/projects/code-exploration-settings-card";
import { ApiError } from "@/lib/api-client";
import { REQUIRES_PROJECT_UPDATE } from "@/lib/permission-hints";
import { projectsApi, type CodeExplorationState } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from "@/lib/api-client";

const fetchMock = vi.mocked(apiFetch);

/** The project as `GET /api/projects/:id` returns it (#2566). */
function project(state: CodeExplorationState) {
  return {
    id: "proj_1",
    name: "Alpha",
    slug: "alpha",
    status: "active",
    createdById: "u",
    createdAt: "",
    updatedAt: "",
    codeExploration: state.setting,
    ...(state.resolved ? { codeExplorationResolved: state.resolved } : {}),
  };
}

/** Answer each `GET /projects/proj_1` with the next of `gets` (the last repeats); PATCH with `patch`. */
function serve(gets: CodeExplorationState[], patch: () => Promise<unknown> = async () => ({})) {
  let i = 0;
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === "PATCH") return patch() as never;
    if (url === "/projects/proj_1") {
      const state = gets[Math.min(i++, gets.length - 1)]!;
      return project(state) as never;
    }
    throw new Error(`unexpected ${url}`);
  });
}

const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");

/**
 * Let a mutation that was started run: TanStack's `mutate` calls `mutationFn`
 * after a tick, not synchronously, so a "no PATCH" check made straight after a
 * click would pass whether or not the click started one.
 */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

const AUTO_FAST: CodeExplorationState = {
  setting: "auto",
  resolved: { mode: "fast", reason: "platform-default" },
};
const AUTO_EXPLORE: CodeExplorationState = {
  setting: "auto",
  resolved: { mode: "explore", reason: "platform-default" },
};
const FAST: CodeExplorationState = {
  setting: "fast",
  resolved: { mode: "fast", reason: "project-fast" },
};
const EXPLORE: CodeExplorationState = {
  setting: "explore",
  resolved: { mode: "explore", reason: "project-explore" },
};

function renderCard(canEdit = true) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <CodeExplorationSettingsCard projectId="proj_1" canEdit={canEdit} />
    </Wrapper>,
  );
}

const radio = (value: string) =>
  screen.getByTestId(`code-exploration-option-${value}`).querySelector("input") as HTMLInputElement;

beforeEach(() => {
  fetchMock.mockReset();
});

describe("CodeExplorationSettingsCard", () => {
  it("shows the three choices with the saved one selected", async () => {
    serve([FAST]);
    renderCard();
    await screen.findByTestId("code-exploration-option-explore");
    expect(screen.getByText("Thorough")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
    expect(screen.getByText("Use the platform default")).toBeInTheDocument();
    await waitFor(() => expect(radio("fast").checked).toBe(true));
    expect(radio("explore").checked).toBe(false);
    expect(radio("auto").checked).toBe(false);
  });

  it("saves Fast with a PATCH, and a reload shows what GET returns, not local state", async () => {
    serve([AUTO_FAST, FAST]);
    const { unmount } = renderCard();
    await waitFor(() => expect(radio("auto").checked).toBe(true));
    fireEvent.click(radio("fast"));
    fireEvent.click(screen.getByTestId("code-exploration-save-button"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual([
      "/projects/proj_1/code-exploration",
      { method: "PATCH", body: { codeExploration: "fast" } },
    ]);
    expect(await screen.findByTestId("code-exploration-saved-toast")).toBeInTheDocument();
    unmount();

    // A reload is a new page with a new cache: it shows the server's value.
    serve([FAST]);
    const reloaded = renderCard();
    await waitFor(() => expect(radio("fast").checked).toBe(true));
    reloaded.unmount();

    // And it is the server's value, whatever was chosen before.
    serve([EXPLORE]);
    renderCard();
    await waitFor(() => expect(radio("explore").checked).toBe(true));
    expect(radio("fast").checked).toBe(false);
  });

  it("with auto, names the platform default the server resolved", async () => {
    serve([AUTO_FAST]);
    const { unmount } = renderCard();
    expect(await screen.findByTestId("code-exploration-platform-default")).toHaveTextContent(
      "Platform default: Fast",
    );
    unmount();
    serve([AUTO_EXPLORE]);
    renderCard();
    expect(await screen.findByTestId("code-exploration-platform-default")).toHaveTextContent(
      "Platform default: Thorough",
    );
  });

  it("names no platform default when the project has its own setting", async () => {
    serve([EXPLORE]);
    renderCard();
    await waitFor(() => expect(radio("explore").checked).toBe(true));
    expect(screen.queryByTestId("code-exploration-platform-default")).toBeNull();
  });

  it("without project.update, the choices and Save are disabled and no PATCH is sent", async () => {
    serve([AUTO_FAST]);
    renderCard(false);
    await waitFor(() => expect(radio("auto").checked).toBe(true));
    expect(screen.getByTestId("code-exploration-permission-hint")).toHaveTextContent(
      REQUIRES_PROJECT_UPDATE,
    );
    for (const value of ["explore", "fast", "auto"]) expect(radio(value)).toBeDisabled();
    const save = screen.getByTestId("code-exploration-save-button");
    expect(save).toBeDisabled();
    fireEvent.click(radio("fast"));
    fireEvent.click(save);
    await settle();
    expect(patches()).toHaveLength(0);
  });

  it("with auto and no resolved default from the server, names no platform default", async () => {
    serve([{ setting: "auto" }]);
    renderCard();
    await waitFor(() => expect(radio("auto").checked).toBe(true));
    expect(screen.queryByTestId("code-exploration-platform-default")).toBeNull();
    expect(screen.queryByText(/Platform default/)).toBeNull();
  });

  it("reads the project through the settings page's query: one GET for page and card", async () => {
    serve([FAST]);
    const Wrapper = makeWrapper({});
    function Page() {
      // What the settings page runs (`page.tsx`): the project detail query.
      useQuery({
        queryKey: queryKeys.projects.detail("proj_1"),
        queryFn: () => projectsApi.get("proj_1"),
      });
      return <CodeExplorationSettingsCard projectId="proj_1" canEdit />;
    }
    render(
      <Wrapper>
        <Page />
      </Wrapper>,
    );
    await waitFor(() => expect(radio("fast").checked).toBe(true));
    await settle();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/projects/proj_1")).toHaveLength(1);
  });

  it("a failed save shows an error and leaves the saved choice selected", async () => {
    serve([AUTO_FAST], async () => {
      throw new ApiError(500, "Server error", "INTERNAL");
    });
    renderCard();
    await waitFor(() => expect(radio("auto").checked).toBe(true));
    fireEvent.click(radio("explore"));
    fireEvent.click(screen.getByTestId("code-exploration-save-button"));
    expect(await screen.findByTestId("code-exploration-error")).toHaveTextContent(
      "The analysis depth was not saved",
    );
    expect(radio("auto").checked).toBe(true);
    expect(radio("explore").checked).toBe(false);
    expect(screen.queryByTestId("code-exploration-saved-toast")).toBeNull();
  });

  it("shows a load error when the project cannot be read", async () => {
    fetchMock.mockRejectedValue(new ApiError(500, "boom", "INTERNAL"));
    renderCard();
    expect(await screen.findByTestId("code-exploration-load-error")).toBeInTheDocument();
  });

  it("keeps implementation words out of its copy", async () => {
    serve([AUTO_FAST]);
    const { container } = renderCard(false);
    await screen.findByTestId("code-exploration-platform-default");
    const copy = [
      container.textContent ?? "",
      ...ANALYSIS_DEPTH_OPTIONS.flatMap((o) => [o.label, o.description]),
    ].join(" ");
    // Whole words only: "return" or "management" are not "turn" or "agent".
    for (const word of ["agent", "token", "turn", "recall"]) {
      expect(copy).not.toMatch(new RegExp(`\\b${word}s?\\b`, "i"));
    }
    // The measured gain is hedged to the product it was measured on.
    expect(copy).toContain("On a real product we tested");
  });
});
