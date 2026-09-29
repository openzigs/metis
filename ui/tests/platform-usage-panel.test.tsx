/**
 * #22 — the admin usage dashboard reports unpriced usage separately, with its
 * token counts, and never renders an unpriced model's cost as $0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { PlatformUsagePanel as AdminUsagePage } from "@/components/usage/platform-usage-panel";

const summary = {
  totalTokens: 2_632_389,
  totalCostUsd: 0.5,
  unpriced: {
    promptTokens: 1_334_017,
    completionTokens: 1_297_372,
    totalTokens: 2_631_389,
    count: 3,
  },
  rows: [
    {
      dayBucket: "2026-09-21",
      provider: "anthropic",
      model: "deepseek-v4-pro",
      projectId: "p1",
      promptTokens: 1_334_017,
      completionTokens: 1_297_372,
      totalTokens: 2_631_389,
      estimatedCostUsd: null,
      unpricedTokens: 2_631_389,
      count: 3,
    },
    {
      dayBucket: "2026-09-21",
      provider: "openai",
      model: "gpt-4o",
      projectId: "p2",
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
      estimatedCostUsd: 0.5,
      unpricedTokens: 0,
      count: 1,
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ success: true, data: summary }))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Admin usage page — unpriced usage (#22)", () => {
  it("shows unpriced tokens in their own tile and 'Unpriced' in the cost column", async () => {
    const Wrapper = makeWrapper({ withAuth: false });
    render(
      <Wrapper>
        <AdminUsagePage />
      </Wrapper>,
    );

    const tile = await screen.findByTestId("admin-usage-unpriced");
    expect(tile).toHaveTextContent("2.6M");
    expect(tile).toHaveTextContent("1.3M in / 1.3M out");
    // The headline cost is the priced portion only.
    expect(screen.getByText("$0.5000", { selector: "p" })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText("Unpriced").length).toBeGreaterThan(0);
    });
    // No unpriced row is rendered as a zero cost.
    expect(screen.queryByText("$0.0000")).not.toBeInTheDocument();
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getByText("Unpriced tokens")).toBeInTheDocument();
  });

  it("shows the Estimated Cost tile as Unpriced, not $0.0000, when all usage is unpriced (PR #41 review)", async () => {
    const allUnpriced = { ...summary, totalCostUsd: 0, rows: [summary.rows[0]] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true, data: allUnpriced }))),
    );
    const Wrapper = makeWrapper({ withAuth: false });
    render(
      <Wrapper>
        <AdminUsagePage />
      </Wrapper>,
    );
    const costTile = await screen.findByTestId("admin-usage-cost");
    expect(costTile).toHaveTextContent("Unpriced");
    expect(costTile).not.toHaveTextContent("$0.0000");
  });
});

describe("Usage & cost — All projects scope (#31)", () => {
  function renderPanel() {
    const Wrapper = makeWrapper({ withAuth: false });
    return render(
      <Wrapper>
        <AdminUsagePage />
      </Wrapper>,
    );
  }

  it("refetches for the chosen range and grouping, labelling each bar by that grouping", async () => {
    const fetchMock = vi.mocked(fetch);
    renderPanel();
    await screen.findByTestId("admin-usage-cost");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/usage?range=30d&groupBy=project");

    fireEvent.change(screen.getByLabelText("Time range"), { target: { value: "7d" } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/usage?range=7d&groupBy=project"),
    );
    for (const [groupBy, label] of [
      ["day", "09-21"],
      ["model", "gpt-4o"],
      ["user", ""],
    ] as const) {
      fireEvent.change(screen.getByLabelText("Group by"), { target: { value: groupBy } });
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(`/api/admin/usage?range=7d&groupBy=${groupBy}`),
      );
      await screen.findByRole("heading", { name: `Token Usage by ${groupBy}` });
      if (label) expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    }
  });

  it("exports the current view as CSV", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderPanel();
    await screen.findByTestId("admin-usage-cost");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(open).toHaveBeenCalledWith("/api/admin/usage/csv?range=30d&groupBy=project", "_blank");
    open.mockRestore();
  });

  it("says so when there is no usage in the period", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: { ...summary, totalTokens: 999, totalCostUsd: 0, rows: [] },
            }),
          ),
      ),
    );
    renderPanel();
    expect(await screen.findByText("No usage data for this period")).toBeInTheDocument();
    expect(screen.getByText("999")).toBeInTheDocument();
  });

  it("reports a failed load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    renderPanel();
    expect(await screen.findByText("Error loading usage data")).toBeInTheDocument();
  });
});
