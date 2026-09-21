/**
 * Tests for the Sync Dashboard page.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SyncDashboardPage from "@/app/(authed)/projects/[id]/sync/page";
import type { DriftEventRow } from "@metis/shared";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects/p1/sync",
  useParams: () => ({ id: "p1" }),
  useSearchParams: () => new URLSearchParams(),
}));

const MOCK_DRIFT: DriftEventRow = {
  id: "drift-1",
  publishedIssueId: "pi-1",
  projectId: "p1",
  requirementId: "req-1",
  source: "github",
  deliveryId: "del-1",
  action: "edited",
  fieldDiffs: [{ field: "title", local: "Old Title", external: "New Title" }],
  externalSnapshot: { title: "New Title", body: "B", state: "open", labels: [], assignees: [] },
  localSnapshot: { title: "Old Title", body: "B", state: "open", labels: [], assignees: [] },
  status: "pending",
  resolution: null,
  resolvedById: null,
  resolvedAt: null,
  createdAt: "2026-05-25T12:00:00Z",
};

const mockFetchDriftEvents = vi.fn();
const mockResolveDrift = vi.fn();

vi.mock("@/lib/sync-api", () => ({
  fetchDriftEvents: (...args: unknown[]) => mockFetchDriftEvents(...args),
  resolveDrift: (...args: unknown[]) => mockResolveDrift(...args),
  fetchDriftCount: vi.fn().mockResolvedValue(0),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SyncDashboardPage", () => {
  it("shows loading state initially then empty state", async () => {
    mockFetchDriftEvents.mockResolvedValue({ items: [], total: 0 });
    render(<SyncDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("All synced up!")).toBeInTheDocument();
    });
  });

  it("shows drift items from API", async () => {
    mockFetchDriftEvents.mockResolvedValue({ items: [MOCK_DRIFT], total: 1 });
    render(<SyncDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("title changed")).toBeInTheDocument();
    });
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
  });

  it("opens diff modal when clicking a drift row", async () => {
    const user = userEvent.setup();
    mockFetchDriftEvents.mockResolvedValue({ items: [MOCK_DRIFT], total: 1 });
    render(<SyncDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("title changed")).toBeInTheDocument();
    });
    await user.click(screen.getByText("title changed"));
    expect(screen.getByText("Drift Details")).toBeInTheDocument();
    expect(screen.getByText("Old Title")).toBeInTheDocument();
    expect(screen.getByText("New Title")).toBeInTheDocument();
  });

  it("resolves drift with adopt action", async () => {
    const user = userEvent.setup();
    mockFetchDriftEvents.mockResolvedValue({ items: [MOCK_DRIFT], total: 1 });
    mockResolveDrift.mockResolvedValue({ ...MOCK_DRIFT, status: "resolved" });
    render(<SyncDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("title changed")).toBeInTheDocument();
    });
    await user.click(screen.getByText("title changed"));
    await user.click(screen.getByText("← Adopt External"));
    expect(mockResolveDrift).toHaveBeenCalledWith("drift-1", "adopt");
  });

  it("resolves drift with push action", async () => {
    const user = userEvent.setup();
    mockFetchDriftEvents.mockResolvedValue({ items: [MOCK_DRIFT], total: 1 });
    mockResolveDrift.mockResolvedValue({ ...MOCK_DRIFT, status: "resolved" });
    render(<SyncDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("title changed")).toBeInTheDocument();
    });
    await user.click(screen.getByText("title changed"));
    await user.click(screen.getByText("Push METIS →"));
    expect(mockResolveDrift).toHaveBeenCalledWith("drift-1", "push");
  });

  it("shows pagination when total exceeds perPage", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...MOCK_DRIFT,
      id: `drift-${i}`,
    }));
    mockFetchDriftEvents.mockResolvedValue({ items, total: 40 });
    render(<SyncDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    });
    expect(screen.getByText("Next")).toBeInTheDocument();
  });
});
