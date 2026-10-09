/**
 * #31 — the workspace FinOps panel, now the Workspace scope of Settings →
 * Usage & cost. Its chart, budget form and alert editor have their own suites.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { WorkspaceFinopsPanel } from "@/components/finops/workspace-finops-panel";
import { finopsApi, type WorkspaceUsageTotals } from "@/lib/finops-api";

vi.mock("@/components/finops/ForecastChart", () => ({
  ForecastChart: ({ budgetCents }: { budgetCents: number | null }) => (
    <div data-testid="forecast-chart">{String(budgetCents)}</div>
  ),
}));
vi.mock("@/components/finops/BudgetForm", () => ({
  BudgetForm: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="budget-form">{workspaceId}</div>
  ),
}));
vi.mock("@/components/finops/AlertRuleEditor", () => ({
  AlertRuleEditor: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="alert-rules">{workspaceId}</div>
  ),
}));
vi.mock("@/lib/finops-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/finops-api")>("@/lib/finops-api");
  return {
    ...actual,
    finopsApi: {
      ...actual.finopsApi,
      getBudget: vi.fn(),
      getForecast: vi.fn(),
      getEvents: vi.fn(),
      getUsageTotals: vi.fn(),
    },
  };
});

const api = vi.mocked(finopsApi);

function renderPanel(workspaceId = "ws-1") {
  return render(<WorkspaceFinopsPanel workspaceId={workspaceId} />, { wrapper: makeWrapper() });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getBudget.mockResolvedValue({ monthlyBudgetCents: 5000 });
  api.getForecast.mockResolvedValue({ forecast: null });
  api.getEvents.mockResolvedValue({ events: [] });
  api.getUsageTotals.mockResolvedValue(totals());
});

function totals(over: Partial<WorkspaceUsageTotals> = {}): WorkspaceUsageTotals {
  return {
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-09T00:00:00.000Z",
    totalTokens: 1_234_567,
    costUsd: 12.3456,
    unpricedTokens: 0,
    calls: 321,
    ...over,
  };
}

describe("<WorkspaceFinopsPanel /> usage totals (#977)", () => {
  it("shows the workspace's month-to-date tokens, cost and calls", async () => {
    renderPanel("ws-9");
    expect(await screen.findByTestId("workspace-usage-tokens")).toHaveTextContent(
      (1_234_567).toLocaleString(),
    );
    expect(api.getUsageTotals).toHaveBeenCalledWith("ws-9");
    expect(screen.getByTestId("workspace-usage-cost")).toHaveTextContent("$12.35");
    expect(screen.getByTestId("workspace-usage-calls")).toHaveTextContent("321");
  });

  it("names unpriced usage beside the cost, and reads Unpriced when nothing was priced", async () => {
    api.getUsageTotals.mockResolvedValue(totals({ unpricedTokens: 900 }));
    const { unmount } = renderPanel();
    expect(await screen.findByTestId("workspace-usage-cost")).toHaveTextContent(
      "$12.35 + 900 unpriced tokens",
    );
    unmount();
    api.getUsageTotals.mockResolvedValue(totals({ costUsd: null, unpricedTokens: 900 }));
    renderPanel();
    expect(await screen.findByTestId("workspace-usage-cost")).toHaveTextContent(/^Unpriced$/);
  });
});

describe("<WorkspaceFinopsPanel /> (#31)", () => {
  it("loads the named workspace's budget, forecast and alerts", async () => {
    renderPanel("ws-9");
    await waitFor(() => expect(screen.getByTestId("forecast-chart")).toHaveTextContent("5000"));
    expect(api.getBudget).toHaveBeenCalledWith("ws-9");
    expect(api.getForecast).toHaveBeenCalledWith("ws-9", undefined);
    expect(api.getEvents).toHaveBeenCalledWith("ws-9");
    expect(screen.getByTestId("budget-form")).toHaveTextContent("ws-9");
    expect(screen.getByTestId("alert-rules")).toHaveTextContent("ws-9");
    expect(screen.getByRole("link", { name: "Download Chargeback PDF" })).toHaveAttribute(
      "href",
      finopsApi.chargebackPdfUrl("ws-9"),
    );
    expect(await screen.findByText("No alerts fired yet.")).toBeInTheDocument();
  });

  it("drills the forecast into one project", async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Project:"), { target: { value: "p1" } });
    await waitFor(() => expect(api.getForecast).toHaveBeenCalledWith("ws-1", "p1"));
  });

  it("lists fired alerts with their spend against budget", async () => {
    api.getEvents.mockResolvedValue({
      events: [
        {
          id: "e1",
          workspaceId: "ws-1",
          ruleId: "r1",
          spendCents: 4500,
          budgetCents: 5000,
          ratio: 0.9,
          basis: "actual",
          deliveries: "[]",
          firedAt: "2026-09-01T00:00:00Z",
        },
      ],
    });
    renderPanel();
    expect(await screen.findByText("90% of budget (actual)")).toBeInTheDocument();
    expect(screen.queryByText("No alerts fired yet.")).not.toBeInTheDocument();
  });

  it("shows no budget while it is unknown", async () => {
    api.getBudget.mockResolvedValue({ monthlyBudgetCents: null });
    renderPanel();
    await waitFor(() => expect(api.getBudget).toHaveBeenCalled());
    expect(screen.getByTestId("forecast-chart")).toHaveTextContent("null");
  });
});
