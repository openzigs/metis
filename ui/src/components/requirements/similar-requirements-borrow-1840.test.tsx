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
  /** #1914 — the similar lists of other cards, by requirement id. */
  otherLists: {} as Record<string, SimilarRequirementItem[]>,
  /** #1931 — a list's next fetch, held open until the test resolves it. */
  pending: {} as Partial<Record<string, Promise<{ items: SimilarRequirementItem[] }>>>,
  directCode: [] as TraceabilityCodeNode[],
  /** #1964 — the chain's next fetch, held open until the test resolves it. */
  chainPending: null as Promise<void> | null,
  failChain: false,
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
  codeSymbolId: null,
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
  codeLinksTruncated: false,
  notDuplicate: false,
  linkedAsDuplicate: false,
};

/** Another card's similar list, `([^/]+)` its requirement id. */
const SIMILAR_PATH = new RegExp(`^/projects/${P}/requirements/([^/]+)/similar$`);

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The fake server's routes. */
function route(path: string, opts: { method?: string; body?: unknown } = {}): unknown {
  if (path === `/projects/${P}/requirements/${SELF}/similar` && !opts.method) {
    return { items: server.items };
  }
  const other = SIMILAR_PATH.exec(path)?.[1];
  if (other && !opts.method && server.pending[other]) {
    // #1931 — a list whose first fetch answers only when the test says so.
    const answer = server.pending[other];
    delete server.pending[other];
    return answer;
  }
  if (other && !opts.method && server.otherLists[other]) {
    return { items: server.otherLists[other] };
  }
  if (path === `/projects/${P}/requirements/${SELF}/traceability` && !opts.method) {
    if (server.failChain) throw new Error("Traceability is down");
    if (server.chainPending) {
      const wait = server.chainPending;
      server.chainPending = null;
      return wait.then(() => route(path, opts));
    }
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

function mount({ canEdit, qc = newClient() }: { canEdit: boolean; qc?: QueryClient }) {
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
  server.otherLists = {};
  server.pending = {};
  server.directCode = [];
  server.chainPending = null;
  server.failChain = false;
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

  it("refetches only the similar lists that name this requirement after a borrow (#1903, #1914)", async () => {
    // Another card's list names this requirement and the code links it holds;
    // a third card's list does not, so a borrow into this one changes nothing in it.
    server.otherLists = {
      "r-other": [{ ...LOT, requirementId: SELF, key: "REQ-1", title: "Recall a batch" }],
      "r-unrelated": [{ ...LOT, requirementId: "r-lot" }],
    };
    const qc = newClient();
    // Another project's list naming the same id is not this project's.
    qc.setQueryData(["similar-requirements", "p2", "r-other"], {
      items: [{ ...LOT, requirementId: SELF }],
    });
    const fetches = (id: string) =>
      apiFetch.mock.calls.filter(([path]) => path === `/projects/${P}/requirements/${id}/similar`)
        .length;
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={qc}>
        <SimilarRequirementsPanel projectId={P} requirementId={SELF} canEdit />
        <SimilarRequirementsPanel projectId={P} requirementId="r-other" />
        <SimilarRequirementsPanel projectId={P} requirementId="r-unrelated" />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: ACTION }));
    await waitFor(() => expect(fetches("r-other") + fetches("r-unrelated")).toBe(2));
    await user.click(await screen.findByRole("button", { name: "Copy 2 links" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    await waitFor(() => expect(fetches("r-other")).toBe(2));
    expect(fetches("r-unrelated")).toBe(1);
    // This card's own list holds the other requirements' links, which a borrow does not change.
    expect(fetches(SELF)).toBe(1);
    expect(qc.getQueryState(["similar-requirements", P, "r-unrelated"])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(["similar-requirements", "p2", "r-other"])?.isInvalidated).toBe(false);
  });

  it("refetches a list still loading when the borrow lands, so it shows the links borrowed (#1931)", async () => {
    // The card's first fetch read this requirement before the borrow committed:
    // no code links. It answers only after the borrow; its refetch reads them.
    let answerFirst!: (v: { items: SimilarRequirementItem[] }) => void;
    server.pending["r-loading"] = new Promise((resolve) => (answerFirst = resolve));
    const before = { ...LOT, requirementId: SELF, key: "REQ-1", title: "Recall a batch" };
    server.otherLists = {
      "r-loading": [{ ...before, codeLinks: [link("fresh", "fresh"), link("moved", "moved")] }],
    };
    const fetches = () =>
      apiFetch.mock.calls.filter(
        ([path]) => path === `/projects/${P}/requirements/r-loading/similar`,
      ).length;
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={newClient()}>
        <SimilarRequirementsPanel projectId={P} requirementId={SELF} canEdit />
        <SimilarRequirementsPanel projectId={P} requirementId="r-loading" />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: ACTION }));
    await waitFor(() => expect(fetches()).toBe(1));
    await user.click(await screen.findByRole("button", { name: "Copy 2 links" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    await waitFor(() => expect(fetches()).toBe(2));
    // The first answer arrives late, from before the borrow: it is not shown.
    answerFirst({ items: [{ ...before, codeLinks: [] }] });
    const loading = screen.getAllByTestId("similar-requirements")[1]!;
    expect(await within(loading).findByText("2 code links: 2 fresh, 0 stale")).toBeInTheDocument();
    expect(within(loading).queryByText("No code links")).toBeNull();
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
    expect(await screen.findByRole("button", { name: "Nothing to copy" })).toBeDisabled();
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
    await user.click(await screen.findByRole("button", { name: "Copy 2 links" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Borrowing is down"));
    expect(screen.getByTestId("borrow-citations-confirm")).toBeInTheDocument();
  });
});

/** #1964 — a code link this requirement holds, as its chain serves it. */
const held = (over: Partial<TraceabilityCodeNode>): TraceabilityCodeNode => ({
  codeSymbolId: null,
  filePath: "src/x.ts",
  startLine: 3,
  endLine: 9,
  confidence: 0.4,
  source: "similar-requirement",
  isTest: false,
  freshness: "fresh",
  originRequirementId: "r-lot",
  originRequirementLabel: "REQ-7",
  ...over,
});

describe("Start from these citations: code already linked (#1964)", () => {
  const confirmGroup = () =>
    screen.getByRole("group", { name: "Copy the code links of REQ-7 Lot tracking for recalls" });

  it("lists links the requirement already holds as already linked, and offers no copy", async () => {
    // It borrowed both current links from REQ-7 before.
    server.directCode = [held({ filePath: "src/fresh.ts" }), held({ filePath: "src/moved.ts" })];
    const user = userEvent.setup();
    mount({ canEdit: true });
    await user.click(await screen.findByRole("button", { name: ACTION }));

    const confirm = confirmGroup();
    expect(await within(confirm).findByTestId("borrow-already-linked")).toHaveTextContent(
      "Already linked (2)src/fresh.ts:3-9src/moved.ts:3-9",
    );
    expect(within(confirm).queryByTestId("borrow-will-copy")).toBeNull();
    expect(confirm).toHaveTextContent(
      "Nothing to copy from REQ-7 Lot tracking for recalls: this requirement already links every one of its code links known to match the current code.",
    );
    expect(within(confirm).getByRole("button", { name: "Nothing to copy" })).toBeDisabled();
    expect(within(confirm).queryByRole("button", { name: /^Copy \d/ })).toBeNull();
  });

  it("copies only what it does not hold, by file and symbol under any source", async () => {
    server.directCode = [
      // The same code, linked by hand: already linked.
      held({ filePath: "src/fresh.ts", source: "manual", originRequirementId: null }),
      // Another symbol of src/moved.ts, not grounded: the origin's link is still copied.
      held({ filePath: "src/moved.ts", codeSymbolId: "sym-other", source: "semantic" }),
    ];
    const user = userEvent.setup();
    mount({ canEdit: true });
    await user.click(await screen.findByRole("button", { name: ACTION }));

    const confirm = confirmGroup();
    expect(await within(confirm).findByTestId("borrow-already-linked")).toHaveTextContent(
      "Already linked (1)src/fresh.ts:3-9",
    );
    expect(within(confirm).getByTestId("borrow-will-copy")).toHaveTextContent(
      "Will be copied (1)src/moved.ts:3-9",
    );
    await user.click(within(confirm).getByRole("button", { name: "Copy 1 link" }));
    expect(server.borrowBodies).toEqual([{ fromRequirementId: "r-lot", mappingIds: ["moved"] }]);
  });

  it("counts any link into a file its own analysis grounded as already linked", async () => {
    server.directCode = [
      held({
        filePath: "src/moved.ts",
        codeSymbolId: "sym-other",
        source: "analysis-grounding",
        originRequirementId: null,
      }),
    ];
    const user = userEvent.setup();
    mount({ canEdit: true });
    await user.click(await screen.findByRole("button", { name: ACTION }));

    const confirm = confirmGroup();
    expect(await within(confirm).findByTestId("borrow-already-linked")).toHaveTextContent(
      "Already linked (1)src/moved.ts:3-9",
    );
    expect(within(confirm).getByTestId("borrow-will-copy")).toHaveTextContent(
      "Will be copied (1)src/fresh.ts:3-9",
    );
  });

  it("offers no copy until it knows what the requirement already links", async () => {
    let answer!: () => void;
    server.chainPending = new Promise((resolve) => (answer = resolve));
    server.directCode = [held({ filePath: "src/fresh.ts" }), held({ filePath: "src/moved.ts" })];
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={newClient()}>
        <SimilarRequirementsPanel projectId={P} requirementId={SELF} canEdit />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: ACTION }));

    const confirm = confirmGroup();
    expect(within(confirm).getByRole("status")).toHaveTextContent(
      "Checking the code this requirement already links",
    );
    expect(within(confirm).queryByTestId("borrow-will-copy")).toBeNull();
    expect(within(confirm).queryByRole("button", { name: /^Copy/ })).toBeNull();

    answer();
    expect(await within(confirm).findByRole("button", { name: "Nothing to copy" })).toBeDisabled();
  });

  it("when the requirement's links cannot be read, previews by the origin alone and says duplicates are skipped", async () => {
    server.failChain = true;
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={newClient()}>
        <SimilarRequirementsPanel projectId={P} requirementId={SELF} canEdit />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: ACTION }));

    const confirm = confirmGroup();
    expect(await within(confirm).findByRole("button", { name: "Copy 2 links" })).toBeEnabled();
    expect(confirm).toHaveTextContent("Code this requirement already links is not copied again.");
    expect(within(confirm).queryByTestId("borrow-already-linked")).toBeNull();
  });
});

describe("borrowPlan", () => {
  it("copies fresh and moved links, skips stale, unchecked and borrowed ones", () => {
    const plan = borrowPlan(LOT.codeLinks);
    expect(plan.copy.map((l) => l.mappingId)).toEqual(["fresh", "moved"]);
    expect(plan.needsRecheck.map((l) => l.mappingId)).toEqual(["stale", "never"]);
    expect(plan.borrowed.map((l) => l.mappingId)).toEqual(["hearsay"]);
    expect(plan.alreadyLinked).toEqual([]);
  });

  it("checks re-check and borrowed before already linked, the server's order (#1964)", () => {
    const plan = borrowPlan(LOT.codeLinks, [
      held({ filePath: "src/stale.ts" }),
      held({ filePath: "src/hearsay.ts" }),
      held({ filePath: "src/fresh.ts" }),
    ]);
    expect(plan.copy.map((l) => l.mappingId)).toEqual(["moved"]);
    expect(plan.alreadyLinked.map((l) => l.mappingId)).toEqual(["fresh"]);
    expect(plan.needsRecheck.map((l) => l.mappingId)).toEqual(["stale", "never"]);
    expect(plan.borrowed.map((l) => l.mappingId)).toEqual(["hearsay"]);
  });

  it("lists a second origin link to code the first one copies as already linked (#1964)", () => {
    const twin = { ...link("fresh", "fresh"), mappingId: "fresh-twin" };
    const plan = borrowPlan([link("fresh", "fresh"), twin], []);
    expect(plan.copy.map((l) => l.mappingId)).toEqual(["fresh"]);
    expect(plan.alreadyLinked.map((l) => l.mappingId)).toEqual(["fresh-twin"]);
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
      "No code links copied from REQ-7. Skipped: 2 already linked, 1 needs a re-check, 3 borrowed themselves, 4 no longer found.",
    );
  });

  it("agrees each reason with its count (#1903)", () => {
    expect(borrowResultText({ ...result, skippedStale: 2, skippedBorrowed: 1 }, "REQ-7")).toBe(
      "No code links copied from REQ-7. Skipped: 2 need a re-check, 1 borrowed itself.",
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
