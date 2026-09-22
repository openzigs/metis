/**
 * Issue #78 — `DriftBadge` was imported by nothing, so the pending-drift count
 * never appeared anywhere in the product. The drift dashboard at
 * `/projects/:id/sync` worked; the at-a-glance badge meant to take an operator
 * there was missing from every surface.
 *
 * It is mounted on the Overview's publish/sync stage. The live-update case is
 * the one worth being careful about: the count has to move on a `drift:detected`
 * push, and a push for a DIFFERENT project must not move it (the badge is
 * project-scoped, and the socket client is shared).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const push = vi.fn();
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1",
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { list: vi.fn() },
  dbConnectorsApi: { list: vi.fn() },
}));
vi.mock("@/lib/projects-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/projects-api")>()),
  documentsApi: { list: vi.fn() },
}));
vi.mock("@/lib/analysis-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/analysis-api")>()),
  analysisApi: { listForProject: vi.fn(), get: vi.fn() },
}));
vi.mock("@/lib/publishing-api", () => ({ publishingApi: { listBatches: vi.fn() } }));
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiFetch: vi.fn(),
}));
vi.mock("@/lib/sync-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync-api")>()),
  fetchDriftCount: vi.fn(),
}));
vi.mock("@/hooks/use-job-events", () => ({ useProjectJobEvents: vi.fn() }));
vi.mock("@/hooks/use-connector-events", () => ({ useConnectorProgress: vi.fn() }));

/** Handlers the overview registers on the socket, keyed by event name. */
const socketHandlers = new Map<string, (payload: unknown) => void>();
const socketMock = {
  emit: vi.fn(),
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    socketHandlers.set(event, handler);
  }),
  off: vi.fn((event: string) => socketHandlers.delete(event)),
};
vi.mock("@/lib/socket-client", () => ({ useSocket: () => socketMock }));

vi.mock("@/lib/auth-context", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-context")>()),
  useAuth: () => ({ user: { id: "u1", permissions: ["issue.preview", "sync.read"] } }),
}));

import { ProjectPipelineOverview } from "@/components/projects/pipeline-overview";
import { repoConnectorsApi, dbConnectorsApi } from "@/lib/connectors-api";
import { documentsApi } from "@/lib/projects-api";
import { analysisApi } from "@/lib/analysis-api";
import { publishingApi } from "@/lib/publishing-api";
import { apiFetch } from "@/lib/api-client";
import { fetchDriftCount } from "@/lib/sync-api";
import { useConnectorProgress } from "@/hooks/use-connector-events";

const driftCount = vi.mocked(fetchDriftCount);
const progress = vi.mocked(useConnectorProgress);

type Progress = ReturnType<typeof useConnectorProgress>;

function renderOverview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ProjectPipelineOverview projectId="p1" />, { wrapper: Wrapper });
}

/** Past the first-run checklist, so the full stage grid renders. */
const COMPLETED_ANALYSIS = {
  id: "a1",
  projectId: "p1",
  startedById: "u1",
  status: "completed" as const,
  startedAt: "2026-09-01T10:00:00Z",
  completedAt: "2026-09-01T10:05:00Z",
  totalTokens: 0,
  errorMessage: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  socketHandlers.clear();
  progress.mockReturnValue({ progressMap: {}, clearProgress: vi.fn() } as unknown as Progress);
  vi.mocked(repoConnectorsApi.list).mockResolvedValue([]);
  vi.mocked(dbConnectorsApi.list).mockResolvedValue([]);
  vi.mocked(documentsApi.list).mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });
  vi.mocked(analysisApi.listForProject).mockResolvedValue({ items: [COMPLETED_ANALYSIS] });
  vi.mocked(analysisApi.get).mockResolvedValue({
    ...COMPLETED_ANALYSIS,
    requirements: [],
  } as never);
  vi.mocked(publishingApi.listBatches).mockResolvedValue([]);
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url === "/projects/p1/docs") return [];
    return [];
  });
  driftCount.mockResolvedValue(0);
});

describe("#78 — drift badge on the project Overview", () => {
  it("shows the pending-drift count without opening the sync page", async () => {
    driftCount.mockResolvedValue(3);
    renderOverview();

    const badge = await screen.findByRole("status", { name: /3 pending drift events/i });
    expect(badge).toHaveTextContent("3");
    expect(driftCount).toHaveBeenCalledWith("p1");
  });

  it("renders nothing when there is no pending drift", async () => {
    driftCount.mockResolvedValue(0);
    renderOverview();

    await screen.findByTestId("pipeline-stage-publish");
    expect(screen.queryByRole("status", { name: /pending drift/i })).toBeNull();
  });

  it("opens that project's sync dashboard when clicked", async () => {
    driftCount.mockResolvedValue(1);
    renderOverview();

    const badge = await screen.findByRole("status", { name: /pending drift/i });
    act(() => badge.click());
    expect(push).toHaveBeenCalledWith("/projects/p1/sync");
  });

  it("updates live when a drift:detected event arrives for this project", async () => {
    driftCount.mockResolvedValue(1);
    renderOverview();
    await screen.findByRole("status", { name: /1 pending drift events/i });

    driftCount.mockResolvedValue(2);
    await act(async () => {
      socketHandlers.get("drift:detected")?.({ projectId: "p1", driftEventId: "d2" });
    });

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /2 pending drift events/i })).toBeInTheDocument(),
    );
  });

  it("ignores a drift:detected event for another project", async () => {
    driftCount.mockResolvedValue(1);
    renderOverview();
    await screen.findByRole("status", { name: /1 pending drift events/i });

    driftCount.mockResolvedValue(9);
    await act(async () => {
      socketHandlers.get("drift:detected")?.({ projectId: "p2", driftEventId: "d9" });
    });

    expect(driftCount).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status", { name: /1 pending drift events/i })).toBeInTheDocument();
  });
});
