/**
 * #738 — every /sessions row read "New Chat · deepseek-flash", so picking the
 * right one to resume was guesswork. A row now names its project (linked to
 * it) and says when the session was last active.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ResumableSessionDto } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import SessionsPage from "@/app/(authed)/sessions/page";
import { sdkApi } from "@/lib/sdk-alignment-api";
import { timeAgo } from "@/lib/time-ago";

vi.mock("@/lib/sdk-alignment-api", () => ({
  sdkApi: { listResumable: vi.fn(), resumeSession: vi.fn() },
}));

const NOW = new Date("2026-10-09T12:00:00Z").getTime();

function row(over: Partial<ResumableSessionDto>): ResumableSessionDto {
  return {
    id: "s",
    projectId: null,
    projectName: null,
    title: "New Chat",
    model: "deepseek-flash",
    currentModel: null,
    currentReasoningEffort: null,
    planModeActive: false,
    status: "active",
    snapshotUpdatedAt: null,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("<SessionsPage /> — project and last activity (#738)", () => {
  it("names each row's project as a link, and says how long ago it was active", async () => {
    vi.mocked(sdkApi.listResumable).mockResolvedValue([
      row({
        id: "s-1",
        projectId: "proj-1",
        projectName: "Billing service",
        updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
      }),
      row({ id: "s-2", updatedAt: new Date(NOW - 3 * 3_600_000).toISOString() }),
    ]);
    render(<SessionsPage />, { wrapper: makeWrapper({ withAuth: false }) });

    const first = await screen.findByTestId("sess-meta-s-1");
    const link = within(first).getByRole("link", { name: "Billing service" });
    expect(link).toHaveAttribute("href", "/projects/proj-1");
    expect(within(first).getByText("5m ago")).toBeInTheDocument();

    const second = screen.getByTestId("sess-meta-s-2");
    expect(within(second).getByText("No project")).toBeInTheDocument();
    expect(within(second).queryByRole("link")).not.toBeInTheDocument();
    expect(within(second).getByText("3h ago")).toBeInTheDocument();
  });
});

describe("timeAgo", () => {
  it.each([
    [10_000, "just now"],
    [5 * 60_000, "5m ago"],
    [3 * 3_600_000, "3h ago"],
    [2 * 86_400_000, "2d ago"],
    [-60_000, "just now"],
  ])("%i ms ago reads %s", (ms, text) => {
    expect(timeAgo(new Date(NOW - ms).toISOString(), NOW)).toBe(text);
  });

  it("an unreadable timestamp renders nothing", () => {
    expect(timeAgo("not a date", NOW)).toBe("");
  });
});
