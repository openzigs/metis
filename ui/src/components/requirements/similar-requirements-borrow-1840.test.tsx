/**
 * Issue #1840 — "Start from these citations" on a similar requirement. The
 * panel and the requirement's code links (`TraceabilityView`) are rendered
 * together in one query cache, the way the analysis page renders them, and
 * `apiFetch` is a small fake SERVER: the borrow writes into the chain it
 * serves, so the borrowed links are asserted in the list the refetch renders.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BorrowCitationsInput,
  RequirementTraceabilityChain,
  SimilarRequirementCodeLink,
  SimilarRequirementItem,
  TraceabilityCodeNode,
} from "@metis/shared";

const server = vi.hoisted(() => ({
  items: [] as SimilarRequirementItem[],
  directCode: [] as TraceabilityCodeNode[],
  borrowBodies: [] as unknown[],
  failBorrow: false,
}));
const apiFetch = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  apiFetch,
  apiErrorMessage: (e: { message?: string } | undefined, fallback: string) =>
    e?.message ?? fallback,
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/analysis-api", () => ({ analysisApi: {} }));
vi.mock("sonner", () => ({ toast }));

import {
  borrowPlan,
  borrowResultText,
  SimilarRequirementsPanel,
} from "./similar-requirements-panel";
import { TraceabilityView } from "@/components/traceability/traceability-view";

const P = "p1";
const SELF = "r-self";

const link = (
  mappingId: string,
  freshness: SimilarRequirementCodeLink["freshness"],
  source = "analysis-grounding",
): SimilarRequirementCodeLink => ({
  mappingId,
  filePath: `src/${mappingId}.ts`,
  startLine: 3,
  endLine: 9,
  source,
  freshness,
});

const LOT: SimilarRequirementItem = {
  requirementId: "r-lot",
  analysisId: "a-1",
  key: "REQ-7",
  title: "Lot tracking for recalls",
  status: "approved",
  score: 0.8,
  label: "overlap",
  codeLinks: [
    link("fresh", "fresh"),
    link("moved", "moved"),
    link("stale", "stale"),
    link("never", "unverified"),
    link("hearsay", "fresh", "similar-requirement"),
  ],
  notDuplicate: false,
  linkedAsDuplicate: false,
};

/** The fake server's routes. */
function route(path: string, opts: { method?: string; body?: unknown } = {}) {
  if (path === `/projects/${P}/requirements/${SELF}/similar` && !opts.method) {
    return { items: server.items };
  }
  if (path === `/projects/${P}/requirements/${SELF}/traceability` && !opts.method) {
    const chain: RequirementTraceabilityChain = {
      requirementId: SELF,
      requirementTitle: "Recall a batch",
      projectId: P,
      specs: [],
      directCode: [...server.directCode],
      testedBy: [],
    };
    return chain;
  }
  if (path === `/projects/${P}/requirements/${SELF}/borrow-citations` && opts.method === "POST") {
    server.borrowBodies.push(opts.body);
    if (server.failBorrow) throw new Error("Borrowing is down");
    const body = opts.body as BorrowCitationsInput;
    const origin = server.items.find((i) => i.requirementId === body.fromRequirementId)!;
    const named = origin.codeLinks.filter((l) => body.mappingIds?.includes(l.mappingId));
    for (const l of named) {
      server.directCode.push({
        codeSymbolId: null,
        filePath: l.filePath,
        startLine: l.startLine,
        endLine: l.endLine,
        confidence: 0.4,
        source: "similar-requirement",
        isTest: false,
        freshness: l.freshness,
        originRequirementId: origin.requirementId,
        originRequirementLabel: origin.key,
      });
    }
    return {
      copied: named.length,
      skippedStale: 0,
      skippedDuplicate: 0,
      skippedBorrowed: 0,
      notFound: 0,
    };
  }
  throw new Error(`unexpected ${opts.method ?? "GET"} ${path}`);
}

function mount({ canEdit }: { canEdit: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SimilarRequirementsPanel projectId={P} requirementId={SELF} canEdit={canEdit} />
      <TraceabilityView projectId={P} requirementId={SELF} />
    </QueryClientProvider>,
  );
}

const ACTION = "Start from the citations of REQ-7 Lot tracking for recalls";

beforeEach(() => {
  server.items = [LOT];
  server.directCode = [];
  server.borrowBodies = [];
  server.failBorrow = false;
  toast.error.mockReset();
  toast.success.mockReset();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) =>
    route(path, opts),
  );
});

describe("Start from these citations (#1840)", () => {
  it("lists what will be copied and what is skipped before confirming", async () => {
    const user = userEvent.setup();
    mount({ canEdit: true });
    await user.click(await screen.findByRole("button", { name: ACTION }));

    const confirm = screen.getByRole("group", {
      name: "Copy the code links of REQ-7 Lot tracking for recalls",
    });
    expect(within(confirm).getByTestId("borrow-will-copy")).toHaveTextContent(
      "Will be copied (2)src/fresh.ts:3-9src/moved.ts:3-9",
    );
    expect(within(confirm).getByTestId("borrow-skipped-stale")).toHaveTextContent(
      "needs a re-check first (2)src/stale.ts:3-9src/never.ts:3-9",
    );
    expect(within(confirm).getByTestId("borrow-skipped-borrowed")).toHaveTextContent(
      "Skipped, borrowed by REQ-7 Lot tracking for recalls itself (1)src/hearsay.ts:3-9",
    );
    // Nothing is written until the analyst confirms.
    expect(server.borrowBodies).toEqual([]);
  });

  it("after confirming, the code links list shows the borrowed links, labelled", async () => {
    const user = userEvent.setup();
    mount({ canEdit: true });
    expect(await screen.findByTestId("traceability-empty")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: ACTION }));
    await user.click(screen.getByRole("button", { name: "Copy 2 links" }));

    // Exactly the links it listed are borrowed.
    expect(server.borrowBodies).toEqual([
      { fromRequirementId: "r-lot", mappingIds: ["fresh", "moved"] },
    ]);
    // The chain is refetched and renders the borrowed links, labelled.
    const rows = await screen.findAllByTestId("traceability-code-row");
    expect(rows.map((r) => within(r).getByRole("code").textContent)).toEqual([
      "src/fresh.ts:3-9",
      "src/moved.ts:3-9",
    ]);
    for (const row of rows) {
      expect(within(row).getByTestId("traceability-borrowed-note")).toHaveTextContent(
        "Borrowed from REQ-7, not yet checked by analysis",
      );
      expect(within(row).getByText("borrowed")).toBeInTheDocument();
    }
    expect(toast.success).toHaveBeenCalledWith("Copied 2 code links from REQ-7.");
    expect(screen.queryByTestId("borrow-citations-confirm")).toBeNull();
  });

  it("is hidden from a viewer without edit rights, and shown to an editor", async () => {
    const viewer = mount({ canEdit: false });
    expect(await screen.findByTestId("similar-requirement")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ACTION })).toBeNull();
    viewer.unmount();

    mount({ canEdit: true });
    expect(await screen.findByRole("button", { name: ACTION })).toBeInTheDocument();
  });

  it("is not offered for a similar requirement with no code links", async () => {
    server.items = [{ ...LOT, codeLinks: [] }];
    mount({ canEdit: true });
    expect(await screen.findByText("No code links")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ACTION })).toBeNull();
  });

  it("says when nothing can be copied, and cannot be confirmed", async () => {
    server.items = [{ ...LOT, codeLinks: [link("stale", "stale")] }];
    const user = userEvent.setup();
    mount({ canEdit: true });
    await user.click(await screen.findByRole("button", { name: ACTION }));
    expect(screen.getByTestId("borrow-citations-confirm")).toHaveTextContent(
      "Nothing to copy from REQ-7 Lot tracking for recalls",
    );
    expect(screen.getByRole("button", { name: "Copy 0 links" })).toBeDisabled();
  });

  it("cancel closes the confirmation without borrowing", async () => {
    const user = userEvent.setup();
    mount({ canEdit: true });
    await user.click(await screen.findByRole("button", { name: ACTION }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("borrow-citations-confirm")).toBeNull();
    expect(screen.getByRole("button", { name: ACTION })).toBeInTheDocument();
    expect(server.borrowBodies).toEqual([]);
  });

  it("reports a failed borrow and keeps the confirmation open", async () => {
    server.failBorrow = true;
    const user = userEvent.setup();
    mount({ canEdit: true });
    await user.click(await screen.findByRole("button", { name: ACTION }));
    await user.click(screen.getByRole("button", { name: "Copy 2 links" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Borrowing is down"));
    expect(screen.getByTestId("borrow-citations-confirm")).toBeInTheDocument();
  });
});

describe("borrowPlan", () => {
  it("copies fresh and moved links, skips stale, unchecked and borrowed ones", () => {
    const plan = borrowPlan(LOT.codeLinks);
    expect(plan.copy.map((l) => l.mappingId)).toEqual(["fresh", "moved"]);
    expect(plan.needsRecheck.map((l) => l.mappingId)).toEqual(["stale", "never"]);
    expect(plan.borrowed.map((l) => l.mappingId)).toEqual(["hearsay"]);
  });
});

describe("borrowResultText", () => {
  const result = {
    copied: 0,
    skippedStale: 0,
    skippedDuplicate: 0,
    skippedBorrowed: 0,
    notFound: 0,
  };

  it("names what was copied, and every reason something was not", () => {
    expect(borrowResultText({ ...result, copied: 1 }, "REQ-7")).toBe(
      "Copied 1 code link from REQ-7.",
    );
    expect(
      borrowResultText(
        { copied: 0, skippedStale: 1, skippedDuplicate: 2, skippedBorrowed: 3, notFound: 4 },
        "REQ-7",
      ),
    ).toBe(
      "No code links copied from REQ-7. Skipped: 2 already linked, 1 need a re-check, 3 borrowed themselves, 4 no longer found.",
    );
  });
});

describe("TraceabilityView — a borrowed link (#1840)", () => {
  const node = (over: Partial<TraceabilityCodeNode>): TraceabilityCodeNode => ({
    codeSymbolId: null,
    filePath: "src/x.ts",
    startLine: null,
    endLine: null,
    confidence: 0.9,
    source: "analysis-grounding",
    isTest: false,
    freshness: "fresh",
    ...over,
  });

  it("names a gone origin generically, and labels only borrowed links", async () => {
    server.directCode = [
      node({ filePath: "src/own.ts" }),
      node({
        filePath: "src/borrowed.ts",
        source: "similar-requirement",
        originRequirementId: "r-gone",
        originRequirementLabel: null,
      }),
    ];
    mount({ canEdit: false });
    const rows = await screen.findAllByTestId("traceability-code-row");
    expect(within(rows[0]!).queryByTestId("traceability-borrowed-note")).toBeNull();
    expect(within(rows[0]!).queryByText("borrowed")).toBeNull();
    expect(within(rows[1]!).getByTestId("traceability-borrowed-note")).toHaveTextContent(
      "Borrowed from a similar requirement, not yet checked by analysis",
    );
  });
});
