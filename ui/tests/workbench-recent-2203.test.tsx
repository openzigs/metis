/**
 * #2203 — the Workbench page's Recent panel, end to end through the page. #2199
 * moved the panel onto `useRecentEntries`, but only the hook and the dashboard
 * widget were tested: putting the page back on the raw tracker left every suite
 * green. This renders the real page over the real tracker and pins that Recent
 * lists only the sessions the server still holds, under the server's title.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import type { ResumableSessionDto } from "@metis/shared";
import { makeWrapper } from "./test-utils";

vi.mock("@tanstack/react-virtual", async () => (await import("./virtualizer-stub")).module);
vi.mock("@/lib/socket-client", () => ({ useSocket: () => null }));
vi.mock("@/lib/sdk-alignment-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/sdk-alignment-api")>("@/lib/sdk-alignment-api");
  return { ...actual, sdkApi: { ...actual.sdkApi, listResumable: vi.fn() } };
});
vi.mock("@/components/chat/agent-picker", () => ({ AgentPicker: () => null }));
vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
  documentsApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { listForProject: vi.fn().mockResolvedValue({ items: [] }) },
}));
vi.mock("@/lib/scheduler-api", () => ({
  tasksApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));
vi.mock("@/lib/templates", () => ({ consumeRunPayload: () => null }));
vi.mock("@/components/chat/loaded-skills-panel", () => ({ LoadedSkillsPanel: () => null }));

import { sdkApi } from "@/lib/sdk-alignment-api";
import { recentTracker } from "@/lib/recent-tracker";
import { RESUMABLE_SESSIONS_KEY } from "@/hooks/use-recent-entries";
import WorkbenchPage from "@/app/(authed)/workbench/page";

const listResumable = vi.mocked(sdkApi.listResumable);

function session(id: string, title: string): ResumableSessionDto {
  return {
    id,
    projectId: null,
    projectName: null,
    title,
    model: "m",
    currentModel: null,
    currentReasoningEffort: null,
    planModeActive: false,
    status: "active",
    snapshotUpdatedAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  };
}

/**
 * #2209 — a second observer of the Recent list's own query, rendered beside the
 * page. Both are told of the query's outcome in one batch, so once this shows
 * the query settled, the page has rendered that outcome too: a settled signal
 * to assert a negative after, in place of a fixed sleep.
 */
function QuerySettledProbe() {
  const { status } = useQuery({
    queryKey: RESUMABLE_SESSIONS_KEY,
    queryFn: () => sdkApi.listResumable(),
    enabled: false,
  });
  return <span data-testid="resumable-status">{status}</span>;
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(
    <>
      <WorkbenchPage />
      <QuerySettledProbe />
    </>,
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  recentTracker.touch({
    kind: "session",
    id: "stale",
    label: "New Chat",
    href: "/workbench?session=stale",
    touchedAt: "2026-10-20T00:00:00Z",
  });
  recentTracker.touch({
    kind: "session",
    id: "live",
    label: "New Chat",
    href: "/workbench?session=live",
    touchedAt: "2026-10-30T03:00:00Z",
  });
  recentTracker.touch({
    kind: "analysis",
    id: "a1",
    label: "Run 1",
    href: "/projects/p/analysis?analysisId=a1",
    touchedAt: "2026-10-30T02:00:00Z",
  });
});
afterEach(() => window.localStorage.clear());

describe("Workbench Recent lists only resumable sessions (#2203)", () => {
  it("hides a session the server no longer lists and names the live one by its title", async () => {
    listResumable.mockResolvedValue([session("live", "Invoice tables")]);
    renderPage();
    const recent = await screen.findByTestId("workbench-recent");
    await waitFor(() => expect(within(recent).getByText("Invoice tables")).toBeInTheDocument());
    expect(within(recent).getByText("Run 1")).toBeInTheDocument();
    expect(within(recent).queryByText("New Chat")).not.toBeInTheDocument();
    expect(within(recent).getAllByRole("link")).toHaveLength(2);
  });

  it("lists no unchecked session when the server cannot be asked", async () => {
    listResumable.mockRejectedValue(new Error("offline"));
    renderPage();
    const recent = await screen.findByTestId("workbench-recent");
    await waitFor(() => expect(screen.getByTestId("resumable-status")).toHaveTextContent("error"));
    expect(
      within(recent)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Run 1"]);
  });
});
