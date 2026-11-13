/**
 * #2348 — Home "My work": grouping, links, empty states, loading, and the
 * admin / non-admin Home layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { MyWorkChangeRequest, MyWorkResponse } from "@metis/shared";
import { makeWrapper, TEST_USER, userWith } from "./test-utils";
import DashboardPage from "@/app/(authed)/dashboard/page";
import { MyWork } from "@/components/dashboard/my-work";
import { changeRequestHref, groupChangeRequests, myWorkApi, timeInState } from "@/lib/my-work";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch: vi.fn(),
}));
vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: vi.fn(async () => ({ items: [], total: 0, limit: 5, offset: 0 })) },
}));
vi.mock("@/lib/scheduler-api", () => ({
  tasksApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  schedulerApi: { list: vi.fn(async () => []) },
}));
vi.mock("@/lib/async-platform-api", () => ({
  asyncApi: { listBackgroundRuns: vi.fn(async () => ({ items: [] })) },
}));
vi.mock("@/lib/sdk-alignment-api", () => ({
  sdkApi: { listResumable: vi.fn(async () => []) },
}));

const fetchMock = vi.mocked(apiFetch);
const NOW = Date.parse("2026-11-11T12:00:00Z");

function cr(overrides: Partial<MyWorkChangeRequest>): MyWorkChangeRequest {
  return {
    id: "run-1",
    title: "Payments BRD.docx",
    projectId: "p-1",
    projectName: "Payments",
    state: "waiting_on_me",
    since: "2026-11-09T12:00:00Z",
    ...overrides,
  };
}

const FULL: MyWorkResponse = {
  changeRequests: [
    cr({ id: "run-ready", title: "Refunds", state: "ready_to_hand_off", reviewId: "rev-ok" }),
    cr({ id: "run-wait", title: "Payments BRD.docx", openQuestions: 2 }),
    cr({ id: "run-rej", title: "Chargebacks", state: "rejected", reviewId: "rev-no" }),
  ],
  reviews: [
    {
      id: "rev-mine",
      title: "Sprint 4 sign-off",
      projectId: "p-2",
      projectName: "Ledger",
      requestedBy: "Bo Lead",
      since: "2026-11-11T09:00:00Z",
    },
  ],
  projectCount: 2,
};

function renderWith(node: React.ReactNode, user = TEST_USER) {
  const Wrapper = makeWrapper({ initialUser: user });
  return render(<Wrapper>{node}</Wrapper>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("my-work helpers", () => {
  it("groups in the fixed state order and omits empty groups", () => {
    const groups = groupChangeRequests(FULL.changeRequests);
    expect(groups.map((g) => [g.state, g.label, g.items.map((i) => i.id)])).toEqual([
      ["waiting_on_me", "Waiting on your answers", ["run-wait"]],
      ["rejected", "Rejected", ["run-rej"]],
      ["ready_to_hand_off", "Ready to hand off", ["run-ready"]],
    ]);
    expect(groupChangeRequests([])).toEqual([]);
  });

  it("opens each row at the step its state is about", () => {
    expect(changeRequestHref(cr({ id: "r 1" }))).toBe(
      "/projects/p-1/analysis?analysisId=r%201&tab=questions",
    );
    expect(changeRequestHref(cr({ state: "in_review", reviewId: "rev/1" }))).toBe(
      "/reviews/rev%2F1",
    );
    expect(changeRequestHref(cr({ state: "rejected", reviewId: "rev-2" }))).toBe("/reviews/rev-2");
    expect(changeRequestHref(cr({ state: "ready_to_hand_off" }))).toBe(
      "/projects/p-1/publish?analysisId=run-1",
    );
    expect(changeRequestHref(cr({ state: "in_review" }))).toBe(
      "/projects/p-1/analysis?analysisId=run-1",
    );
  });

  it("says how long it has been in its state", () => {
    expect(timeInState("2026-11-09T12:00:00Z", NOW)).toBe("for 2d");
    expect(timeInState("2026-11-11T09:00:00Z", NOW)).toBe("for 3h");
    expect(timeInState("2026-11-11T11:59:30Z", NOW)).toBe("for under a minute");
    expect(timeInState("not a date", NOW)).toBe("");
  });

  it("reads My work from one endpoint", async () => {
    fetchMock.mockResolvedValueOnce(FULL);
    await expect(myWorkApi.get()).resolves.toBe(FULL);
    expect(fetchMock).toHaveBeenCalledWith("/me/work");
  });
});

describe("<MyWork />", () => {
  it("shows a skeleton while loading", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderWith(<MyWork />);
    expect(screen.getByRole("status", { name: "Loading your work" })).toBeInTheDocument();
  });

  it("lists change requests by state and the reviews assigned to me", async () => {
    fetchMock.mockResolvedValue(FULL);
    renderWith(<MyWork />);
    const waiting = await screen.findByTestId("my-work-group-waiting_on_me");
    expect(
      within(waiting).getByRole("heading", { level: 3, name: /Waiting on your answers \(1\)/ }),
    ).toBeInTheDocument();
    expect(within(waiting).getByRole("link", { name: "Payments BRD.docx" })).toHaveAttribute(
      "href",
      "/projects/p-1/analysis?analysisId=run-wait&tab=questions",
    );
    expect(
      within(waiting).getByText(/Payments · for 2d · 2 questions waiting/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("my-work-group-in_review")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("my-work-group-rejected")).getByRole("link", {
        name: "Chargebacks",
      }),
    ).toHaveAttribute("href", "/reviews/rev-no");

    const reviews = screen.getByTestId("my-work-reviews");
    expect(within(reviews).getByRole("link", { name: "Sprint 4 sign-off" })).toHaveAttribute(
      "href",
      "/reviews/rev-mine",
    );
    expect(within(reviews).getByText("Ledger · requested by Bo Lead · for 3h")).toBeInTheDocument();
  });

  it("says one question in the singular", async () => {
    fetchMock.mockResolvedValue({
      ...FULL,
      changeRequests: [cr({ openQuestions: 1 })],
      reviews: [],
    });
    renderWith(<MyWork />);
    expect(await screen.findByText(/· 1 question waiting$/)).toBeInTheDocument();
    expect(screen.queryByTestId("my-work-reviews")).not.toBeInTheDocument();
  });

  it("offers New change request when nothing needs me and I have projects", async () => {
    fetchMock.mockResolvedValue({ changeRequests: [], reviews: [], projectCount: 3 });
    // #2450 — offered only to a session that may start one.
    renderWith(<MyWork />, userWith("analysis.run"));
    expect(await screen.findByText("Nothing needs you right now")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New change request" })).toHaveAttribute(
      "href",
      "/projects",
    );
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
  });

  it("#2450 — offers no New change request to a session without analysis.run", async () => {
    fetchMock.mockResolvedValue({ changeRequests: [], reviews: [], projectCount: 3 });
    renderWith(<MyWork />, { ...TEST_USER, role: "reader", permissions: ["analysis.read"] });
    expect(await screen.findByText("Nothing needs you right now")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New change request" })).not.toBeInTheDocument();
  });

  it("names the next step instead of New project for a role that cannot create one", async () => {
    fetchMock.mockResolvedValue({ changeRequests: [], reviews: [], projectCount: 0 });
    renderWith(<MyWork />, { ...TEST_USER, role: "developer" });
    expect(
      await screen.findByText(
        "You are not in any project yet. Ask an admin or coordinator to add you to one.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
  });

  it("offers the New-project wizard when I have no projects", async () => {
    fetchMock.mockResolvedValue({ changeRequests: [], reviews: [], projectCount: 0 });
    // #2368 — the wizard opens only for a session granted project.create.
    renderWith(<MyWork />, userWith("project.create"));
    const button = await screen.findByRole("button", { name: "New project" });
    act(() => button.click());
    expect(await screen.findByTestId("new-project-wizard")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New change request" })).not.toBeInTheDocument();
  });

  it("says when My work could not be loaded, and retries", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(FULL);
    renderWith(<MyWork />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your work could not be loaded.");
    act(() => screen.getByRole("button", { name: "Try again" }).click());
    expect(await screen.findByTestId("my-work-group-waiting_on_me")).toBeInTheDocument();
  });
});

describe("Home layout (#2348)", () => {
  const ANALYST = { ...TEST_USER, id: "u-ana", role: "developer" as const };

  beforeEach(() => fetchMock.mockResolvedValue(FULL));

  it("shows a non-admin My work, Projects and Recent, and no Tasks, Runs or Scheduler", async () => {
    renderWith(<DashboardPage />, ANALYST);
    expect(await screen.findByTestId("my-work-group-waiting_on_me")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "My work" })).toBeInTheDocument();
    for (const id of ["widget-tasks", "widget-bg-runs", "widget-scheduler"]) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    // The issue removes only the three operations widgets.
    expect(screen.getByTestId("widget-projects")).toBeInTheDocument();
    expect(screen.getByTestId("widget-recent")).toBeInTheDocument();
    // #2364 deferred — no link to an operator page a non-admin is refused.
    await waitFor(() => expect(screen.queryByTestId("widget-projects-empty-cta")).toBeTruthy());
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^\/(tasks|scheduler)\b/);
    }
  });

  it("does not offer New project in an empty Projects widget to a role that cannot create one", async () => {
    renderWith(<DashboardPage />, ANALYST);
    const widget = await screen.findByTestId("widget-projects");
    await waitFor(() => expect(within(widget).getByText("No projects yet")).toBeInTheDocument());
    expect(
      within(widget).getByText("Ask an admin or coordinator to add you to a project."),
    ).toBeInTheDocument();
    expect(within(widget).queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
  });

  it("renders no widgets until the session is known, then an admin's", async () => {
    let resolveMe: (v: unknown) => void = () => {};
    fetchMock.mockImplementation(((path: string) =>
      path === "/auth/me"
        ? new Promise<unknown>((r) => {
            resolveMe = r;
          })
        : Promise.resolve(FULL)) as typeof apiFetch);
    renderWith(<DashboardPage />, null as unknown as typeof TEST_USER);
    await screen.findByTestId("my-work-group-waiting_on_me");
    for (const id of ["widget-projects", "widget-recent", "widget-tasks"]) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    await act(async () => resolveMe({ user: TEST_USER }));
    expect(await screen.findByTestId("widget-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("widget-scheduler")).toBeInTheDocument();
  });

  it("keeps an admin's operations widgets, below My work", async () => {
    renderWith(<DashboardPage />);
    await screen.findByTestId("my-work-group-waiting_on_me");
    const myWork = screen.getByTestId("my-work");
    for (const id of ["widget-projects", "widget-tasks", "widget-bg-runs", "widget-scheduler"]) {
      const widget = screen.getByTestId(id);
      // DOCUMENT_POSITION_FOLLOWING: the widget comes after My work.
      expect(
        myWork.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("makes one request for My work", async () => {
    renderWith(<DashboardPage />, ANALYST);
    await screen.findByTestId("my-work-group-waiting_on_me");
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([path]) => path === "/me/work")).toHaveLength(1),
    );
  });
});
