/**
 * #2187 — walkthrough run 10 (`c-10-7`): Workbench Recent listed seven untitled
 * "New Chat" sessions that `/sessions` did not show. Recent read only the
 * browser's tracker, which never expires an entry and is shared by every user
 * who signs in on that browser. A session now shows in Recent only while the
 * server lists it among the caller's resumable sessions, under the server's
 * title.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ResumableSessionDto } from "@metis/shared";
import { makeWrapper, TEST_USER } from "./test-utils";

vi.mock("@/lib/sdk-alignment-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/sdk-alignment-api")>("@/lib/sdk-alignment-api");
  return { ...actual, sdkApi: { ...actual.sdkApi, listResumable: vi.fn() } };
});
vi.mock("@/lib/projects-api", () => ({ projectsApi: { list: vi.fn() } }));
// #2348 — My work loads above the widgets on Home.
vi.mock("@/lib/my-work", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/my-work")>()),
  myWorkApi: {
    get: vi.fn(async () => ({ changeRequests: [], reviews: [], projectCount: 1 })),
  },
}));
vi.mock("@/lib/scheduler-api", () => ({
  tasksApi: { list: vi.fn() },
  schedulerApi: { list: vi.fn() },
}));

import { sdkApi } from "@/lib/sdk-alignment-api";
import { projectsApi } from "@/lib/projects-api";
import { tasksApi, schedulerApi } from "@/lib/scheduler-api";
import { reconcileRecentSessions, recentTracker, type RecentEntry } from "@/lib/recent-tracker";
import { useRecentEntries } from "@/hooks/use-recent-entries";
import DashboardPage from "@/app/(authed)/dashboard/page";

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

function entry(kind: RecentEntry["kind"], id: string, label: string, at: string): RecentEntry {
  return { kind, id, label, href: `/x/${id}`, touchedAt: at };
}

describe("reconcileRecentSessions (#2187)", () => {
  const entries = [
    entry("session", "live", "New Chat", "2026-10-30T03:00:00Z"),
    entry("analysis", "a1", "Run 1", "2026-10-30T02:00:00Z"),
    entry("session", "stale", "New Chat", "2026-10-20T00:00:00Z"),
  ];

  it("drops a session the server no longer lists and keeps analyses", () => {
    const out = reconcileRecentSessions(entries, [session("live", "Which tables hold invoices?")]);
    expect(out.map((e) => e.id)).toEqual(["live", "a1"]);
  });

  it("labels a session with the title the server holds", () => {
    const out = reconcileRecentSessions(entries, [session("live", "Which tables hold invoices?")]);
    expect(out[0]).toMatchObject({ id: "live", label: "Which tables hold invoices?" });
  });

  it("keeps the tracker's label when the server's title is empty", () => {
    const out = reconcileRecentSessions(entries, [session("live", "")]);
    expect(out[0]).toMatchObject({ id: "live", label: "New Chat" });
  });

  it("keeps a session touched after the answer was read, drops one touched before", () => {
    const answeredAt = Date.parse("2026-10-25T00:00:00Z");
    expect(reconcileRecentSessions(entries, [], answeredAt).map((e) => e.id)).toEqual([
      "live",
      "a1",
    ]);
  });

  it("drops every session when the server lists none", () => {
    expect(reconcileRecentSessions(entries, []).map((e) => e.id)).toEqual(["a1"]);
  });
});

describe("useRecentEntries (#2187)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    recentTracker.touch(entry("session", "live", "New Chat", "2026-10-30T03:00:00Z"));
    recentTracker.touch(entry("session", "stale", "New Chat", "2026-10-20T00:00:00Z"));
    recentTracker.touch(entry("analysis", "a1", "Run 1", "2026-10-30T02:00:00Z"));
  });
  afterEach(() => window.localStorage.clear());

  it("lists no session until the server answers, then only the ones it lists", async () => {
    let answer: (v: ResumableSessionDto[]) => void = () => undefined;
    listResumable.mockReturnValue(new Promise((r) => (answer = r)));
    const { result } = renderHook(() => useRecentEntries(5000), { wrapper: makeWrapper({}) });
    expect(result.current.map((e) => e.id)).toEqual(["a1"]);
    answer([session("live", "Invoice tables")]);
    await waitFor(() => expect(result.current.map((e) => e.id)).toEqual(["live", "a1"]));
    expect(result.current[0].label).toBe("Invoice tables");
  });

  it("lists no unchecked session when the server cannot be asked", async () => {
    listResumable.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useRecentEntries(5000), { wrapper: makeWrapper({}) });
    await waitFor(() => expect(listResumable).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.map((e) => e.id)).toEqual(["a1"]);
  });

  it("shows a session touched after the server's answer before the next refetch", async () => {
    listResumable.mockResolvedValue([session("live", "Invoice tables")]);
    const { result } = renderHook(() => useRecentEntries(20), { wrapper: makeWrapper({}) });
    await waitFor(() => expect(result.current.map((e) => e.id)).toEqual(["live", "a1"]));
    recentTracker.touch(
      entry("session", "fresh", "New Chat", new Date(Date.now() + 1000).toISOString()),
    );
    await waitFor(() => expect(result.current.map((e) => e.id)).toContain("fresh"));
    expect(listResumable).toHaveBeenCalledTimes(1);
  });
});

describe("dashboard Recent activity lists only resumable sessions (#2187)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(projectsApi.list).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    vi.mocked(tasksApi.list).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(schedulerApi.list).mockResolvedValue([]);
  });
  afterEach(() => window.localStorage.clear());

  it("hides a stale untitled session and shows the live one by its title", async () => {
    recentTracker.touch(entry("session", "stale", "New Chat", "2026-10-20T00:00:00Z"));
    recentTracker.touch(entry("session", "live", "New Chat", "2026-10-30T03:00:00Z"));
    listResumable.mockResolvedValue([session("live", "Invoice tables")]);
    const Wrapper = makeWrapper({ initialUser: TEST_USER });
    render(
      <Wrapper>
        <DashboardPage />
      </Wrapper>,
    );
    expect(await screen.findByText("Invoice tables")).toBeInTheDocument();
    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
  });
});
