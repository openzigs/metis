/**
 * Epic #164 — Project usage page rendering tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "p1" }),
    usePathname: () => "/projects/p1/usage",
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: vi.fn(),
      getUsage: vi.fn(),
      getSafetyEvents: vi.fn(),
    },
  };
});

import { projectsApi } from "@/lib/projects-api";
import ProjectUsagePage from "@/app/(authed)/projects/[id]/usage/page";

const get = projectsApi.get as unknown as ReturnType<typeof vi.fn>;
const getUsage = projectsApi.getUsage as unknown as ReturnType<typeof vi.fn>;
const getSafetyEvents = projectsApi.getSafetyEvents as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  get.mockReset();
  getUsage.mockReset();
  getSafetyEvents.mockReset();
});

function makeUsage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    projectId: "p1",
    from: "2026-04-01T00:00:00.000Z",
    to: "2026-04-25T00:00:00.000Z",
    inputTokens: 800,
    outputTokens: 200,
    totalTokens: 1000,
    costCents: 50,
    projectedMonthlyCostCents: 600,
    monthlyTokenBudget: 5_000,
    monthToDateTokens: 1000,
    byProvider: [
      {
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 1000,
        costCents: 50,
      },
    ],
    byDay: [
      { day: "2026-04-22", inputTokens: 100, outputTokens: 50, totalTokens: 150, costCents: 7 },
      { day: "2026-04-23", inputTokens: 700, outputTokens: 150, totalTokens: 850, costCents: 43 },
    ],
    ...overrides,
  };
}

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <ProjectUsagePage />
    </Wrapper>,
  );
}

describe("Project usage page", () => {
  it("renders headline tiles with month-to-date totals", async () => {
    get.mockResolvedValue({ id: "p1", name: "Demo" });
    getUsage.mockResolvedValue(makeUsage());
    getSafetyEvents.mockResolvedValue({ items: [] });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("usage-root")).toBeInTheDocument();
    });
    expect(screen.getByTestId("tile-mtd-tokens")).toHaveTextContent("1,000");
    expect(screen.getByTestId("tile-projected-cost")).toHaveTextContent("$6.00");
    expect(screen.getByTestId("tile-window-cost")).toHaveTextContent("$0.50");
  });

  it("renders the by-provider breakdown table", async () => {
    get.mockResolvedValue({ id: "p1", name: "Demo" });
    getUsage.mockResolvedValue(makeUsage());
    getSafetyEvents.mockResolvedValue({ items: [] });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("usage-by-provider-table")).toBeInTheDocument();
    });
    expect(screen.getByTestId("usage-by-provider-table")).toHaveTextContent("openai");
    expect(screen.getByTestId("usage-by-provider-table")).toHaveTextContent("gpt-4o");
    expect(screen.getByTestId("usage-by-day-chart")).toBeInTheDocument();
  });

  it("renders the safety events table with verdict badges", async () => {
    get.mockResolvedValue({ id: "p1", name: "Demo" });
    getUsage.mockResolvedValue(makeUsage());
    getSafetyEvents.mockResolvedValue({
      items: [
        {
          id: "ev1",
          projectId: "p1",
          sessionId: "s1",
          direction: "input",
          verdict: "blocked",
          findings: [{ kind: "prompt_injection", count: 1 }],
          createdAt: "2026-04-25T12:00:00.000Z",
        },
        {
          id: "ev2",
          projectId: "p1",
          sessionId: "s1",
          direction: "output",
          verdict: "redacted",
          findings: [{ kind: "ssn", count: 1 }],
          createdAt: "2026-04-25T12:01:00.000Z",
        },
      ],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("safety-events-table")).toBeInTheDocument();
    });
    expect(screen.getByTestId("verdict-badge-blocked")).toBeInTheDocument();
    expect(screen.getByTestId("verdict-badge-redacted")).toBeInTheDocument();
    expect(screen.getByTestId("safety-events-table")).toHaveTextContent("prompt_injection");
  });

  it("flags over-budget state with the destructive bar + message", async () => {
    get.mockResolvedValue({ id: "p1", name: "Demo" });
    getUsage.mockResolvedValue(makeUsage({ monthlyTokenBudget: 100, monthToDateTokens: 250 }));
    getSafetyEvents.mockResolvedValue({ items: [] });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("usage-over-budget")).toBeInTheDocument();
    });
    expect(screen.getByTestId("usage-budget-bar")).toBeInTheDocument();
  });

  it("shows the empty-state when no budget is configured", async () => {
    get.mockResolvedValue({ id: "p1", name: "Demo" });
    getUsage.mockResolvedValue(makeUsage({ monthlyTokenBudget: null }));
    getSafetyEvents.mockResolvedValue({ items: [] });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("usage-no-budget")).toBeInTheDocument();
    });
  });

  it("renders the morph-apply summary when morph rows exist (Epic #195)", async () => {
    get.mockResolvedValue({ id: "p1", name: "Demo" });
    getUsage.mockResolvedValue(
      makeUsage({
        byProvider: [
          {
            provider: "openai",
            model: "gpt-4o",
            inputTokens: 800,
            outputTokens: 200,
            totalTokens: 1000,
            costCents: 50,
          },
          {
            provider: "openai",
            model: "morph:morph-v3",
            inputTokens: 300,
            outputTokens: 100,
            totalTokens: 400,
            costCents: 12,
          },
        ],
      }),
    );
    getSafetyEvents.mockResolvedValue({ items: [] });

    renderPage();
    await waitFor(() => expect(screen.getByTestId("morph-apply-card")).toBeInTheDocument());
    expect(screen.getByTestId("morph-apply-tokens")).toHaveTextContent("400");
    expect(screen.getByTestId("morph-apply-cost")).toHaveTextContent("$0.12");
    expect(screen.getByTestId("morph-apply-models")).toHaveTextContent("morph:morph-v3");
  });

  it("shows the morph-apply empty state when no morph rows present", async () => {
    get.mockResolvedValue({ id: "p1", name: "Demo" });
    getUsage.mockResolvedValue(makeUsage());
    getSafetyEvents.mockResolvedValue({ items: [] });

    renderPage();
    await waitFor(() => expect(screen.getByTestId("morph-apply-empty")).toBeInTheDocument());
  });
});
