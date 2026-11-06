/**
 * #1833 (epic #1827) — the requirement card's code links say which still point
 * at the code they were read from, and offer a re-run to those who may run one.
 *
 * Rendered through `TraceabilityView`, the way the analysis page renders it,
 * from a traceability chain whose direct links carry #1830/#1831's freshness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementTraceabilityChain, TraceabilityCodeNode } from "@metis/shared";

const chain = vi.fn();
vi.mock("@/lib/traceability-api", () => ({
  traceabilityApi: { chain: (...args: unknown[]) => chain(...args) },
}));
const apiFetch = vi.fn();
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const regenerateAgent = vi.fn();
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { regenerateAgent: (...args: unknown[]) => regenerateAgent(...args) },
}));

import { TraceabilityView } from "./traceability-view";

const link = (over: Partial<TraceabilityCodeNode>): TraceabilityCodeNode => ({
  codeSymbolId: null,
  filePath: "src/x.ts",
  startLine: 1,
  endLine: 5,
  confidence: 0.8,
  source: "analysis-grounding",
  isTest: false,
  ...over,
});

const FRESH = link({
  filePath: "src/orders/pay.ts",
  freshness: "fresh",
  commitSha: "def5678000",
});
const MOVED = link({
  filePath: "src/orders/receipt.ts",
  startLine: 3,
  endLine: 9,
  freshness: "moved",
  commitSha: "def5678000",
  previousFilePath: "src/orders/old-receipt.ts",
  previousStartLine: 10,
  previousEndLine: 16,
});
const STALE = link({
  filePath: "src/orders/refund.ts",
  freshness: "stale",
  staleReason: "content-changed",
  commitSha: "abc1234ffff",
});
const LEGACY = link({ filePath: "src/orders/legacy.ts", freshness: "unverified" });

const chainWith = (directCode: TraceabilityCodeNode[]): RequirementTraceabilityChain => ({
  requirementId: "req-1",
  requirementTitle: "Refund a paid order",
  projectId: "proj-1",
  specs: [],
  testedBy: [],
  directCode,
});

function renderView(props: { canRerunEvaluation?: boolean; analysisId?: string | null } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={qc}>
      <TraceabilityView projectId="proj-1" requirementId="req-1" analysisId="an-1" {...props} />
    </QueryClientProvider>
  );
  return { ...render(ui), qc };
}

const rows = () => screen.getAllByTestId("traceability-code-row");
const rowFor = (filePath: string) =>
  rows().find((r) => r.textContent?.includes(filePath)) as HTMLElement;

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("code link freshness on the requirement card (#1833)", () => {
  it("renders fresh, moved and stale as three distinct states, in words", async () => {
    chain.mockResolvedValue(chainWith([FRESH, MOVED, STALE, LEGACY]));
    renderView();
    await waitFor(() => expect(rows()).toHaveLength(4));

    const state = (filePath: string) =>
      within(rowFor(filePath)).queryByTestId("code-link-freshness")?.textContent ?? null;
    expect(state(FRESH.filePath)).toBe("Up to date");
    expect(state(MOVED.filePath)).toBe("Moved");
    expect(state(STALE.filePath)).toBe("Out of date");
    // A link never checked shows no state at all.
    expect(state(LEGACY.filePath)).toBeNull();

    expect(within(rowFor(MOVED.filePath)).getByTestId("code-link-moved-from")).toHaveTextContent(
      "Moved from src/orders/old-receipt.ts:10-16",
    );
    expect(within(rowFor(STALE.filePath)).getByTestId("code-link-stale-reason")).toHaveTextContent(
      "The code it pointed to has changed.",
    );
    expect(within(rowFor(FRESH.filePath)).queryByTestId("code-link-stale-reason")).toBeNull();
  });

  it("explains each stale reason in an analyst's words", async () => {
    chain.mockResolvedValue(
      chainWith([
        link({ filePath: "a.ts", freshness: "stale", staleReason: "file-missing" }),
        link({ filePath: "b.ts", freshness: "stale", staleReason: "symbol-missing" }),
        link({ filePath: "c.ts", freshness: "stale", staleReason: null }),
      ]),
    );
    renderView();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const reason = (f: string) =>
      within(rowFor(f)).getByTestId("code-link-stale-reason").textContent;
    expect(reason("a.ts")).toBe("The file it pointed to was removed or renamed.");
    expect(reason("b.ts")).toBe("The function it pointed to can no longer be found.");
    expect(reason("c.ts")).toBe("The code it pointed to may have changed.");
  });

  it("summarises the out-of-date links since the commit they were read at", async () => {
    chain.mockResolvedValue(chainWith([FRESH, MOVED, STALE, LEGACY]));
    renderView();
    const summary = await screen.findByTestId("code-links-stale-summary");
    expect(summary).toHaveTextContent(
      "1 of 4 code links may be out of date: the code changed since commit abc1234.",
    );
    // The count badge has an accessible name, not only a colour.
    expect(screen.getByLabelText("1 of 4 code links may be out of date")).toHaveTextContent(
      "1 out of date",
    );
  });

  it("counts the badge from the links shown: one more stale link, one more in the badge", async () => {
    chain.mockResolvedValue(chainWith([FRESH, MOVED, STALE, LEGACY]));
    const { qc } = renderView();
    await screen.findByTestId("code-links-stale-summary");
    expect(screen.getByTestId("code-links-stale-count")).toHaveTextContent("1 out of date");

    chain.mockResolvedValue(
      chainWith([
        FRESH,
        { ...MOVED, freshness: "stale", staleReason: "file-missing", commitSha: "abc1234ffff" },
        STALE,
        LEGACY,
      ]),
    );
    await qc.invalidateQueries();
    await waitFor(() =>
      expect(screen.getByTestId("code-links-stale-count")).toHaveTextContent("2 out of date"),
    );
    expect(screen.getByTestId("code-links-stale-summary")).toHaveTextContent(
      "2 of 4 code links may be out of date",
    );
  });

  it("names no commit when the stale links were read at different or unknown commits", async () => {
    chain.mockResolvedValue(
      chainWith([STALE, link({ filePath: "b.ts", freshness: "stale", commitSha: null })]),
    );
    renderView();
    expect(await screen.findByTestId("code-links-stale-summary")).toHaveTextContent(
      "2 of 2 code links may be out of date: the code changed since they were saved.",
    );
  });

  it("shows no summary when no link is out of date", async () => {
    chain.mockResolvedValue(chainWith([FRESH, MOVED, LEGACY]));
    renderView({ canRerunEvaluation: true });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByTestId("code-links-stale-summary")).toBeNull();
    expect(screen.queryByRole("button", { name: /re-run/i })).toBeNull();
  });
});

describe("Re-run code evaluation (#1833)", () => {
  const ESTIMATE = {
    selection: { estimatedCost: 0.42 },
    estimate: { tokens: 120000, sampleSize: 3 },
  };

  it("is hidden for a viewer who may not run analyses", async () => {
    chain.mockResolvedValue(chainWith([STALE]));
    renderView({ canRerunEvaluation: false });
    await screen.findByTestId("code-links-stale-summary");
    expect(screen.queryByRole("button", { name: /re-run code evaluation/i })).toBeNull();
  });

  it("shows the cost estimate before starting, and starts only on confirmation", async () => {
    chain.mockResolvedValue(chainWith([STALE]));
    apiFetch.mockResolvedValue(ESTIMATE);
    regenerateAgent.mockResolvedValue({ accepted: true });
    renderView({ canRerunEvaluation: true });

    fireEvent.click(await screen.findByRole("button", { name: "Re-run code evaluation" }));
    expect(regenerateAgent).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("code-link-rerun-confirm");
    expect(confirm).toHaveTextContent("not only this requirement");
    await waitFor(() =>
      expect(screen.getByTestId("code-link-rerun-estimate")).toHaveTextContent(
        "Estimated cost: about $0.42 (120,000 tokens, from 3 previous runs).",
      ),
    );
    expect(apiFetch).toHaveBeenCalledWith("/projects/proj-1/analyses/model-recommendation", {
      method: "POST",
      body: { override: "auto", agentKeys: ["code"], requirementText: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start re-run" }));
    await waitFor(() => expect(regenerateAgent).toHaveBeenCalledWith("an-1", "code"));
    await waitFor(() => expect(screen.queryByTestId("code-link-rerun-confirm")).toBeNull());
  });

  it("says plainly when there is no estimate yet, and Cancel starts nothing", async () => {
    chain.mockResolvedValue(chainWith([STALE]));
    apiFetch.mockResolvedValue({
      selection: { estimatedCost: null },
      estimate: { tokens: null, sampleSize: 0 },
    });
    renderView({ canRerunEvaluation: true });
    fireEvent.click(await screen.findByRole("button", { name: "Re-run code evaluation" }));
    await waitFor(() =>
      expect(screen.getByTestId("code-link-rerun-estimate")).toHaveTextContent(
        "No cost estimate yet",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("code-link-rerun-confirm")).toBeNull();
    expect(regenerateAgent).not.toHaveBeenCalled();
  });

  it("is not offered without the analysis the requirement came from", async () => {
    chain.mockResolvedValue(chainWith([STALE]));
    renderView({ canRerunEvaluation: true, analysisId: null });
    await screen.findByTestId("code-links-stale-summary");
    expect(screen.queryByRole("button", { name: /re-run/i })).toBeNull();
  });
});
