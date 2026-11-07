/**
 * Issue #1838 — similar requirements on a requirement's card and while writing a
 * new one. `apiFetch` is a small fake SERVER that keeps its own state, so "Not a
 * duplicate" is proven by a fresh mount (a reload: new query cache, nothing
 * carried over) reading the answer back through the API.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimilarRequirementItem } from "@metis/shared";

const server = vi.hoisted(() => ({
  dismissed: new Set<string>(),
  linked: new Set<string>(),
  items: [] as SimilarRequirementItem[],
}));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  apiFetch,
  apiErrorMessage: (e: { message?: string } | undefined, fallback: string) =>
    e?.message ?? fallback,
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import {
  codeLinkSummary,
  DRAFT_DEBOUNCE_MS,
  DraftSimilarRequirements,
  EMPTY_TEXT,
  SimilarRequirementsPanel,
} from "./similar-requirements-panel";

const P = "p1";
const SELF = "r-self";

const item = (over: Partial<SimilarRequirementItem>): SimilarRequirementItem => ({
  requirementId: "r-x",
  analysisId: "a-1",
  key: null,
  title: "Something",
  status: "draft",
  score: 0.7,
  label: "related",
  codeLinks: [],
  notDuplicate: false,
  linkedAsDuplicate: false,
  ...over,
});

const LOT = item({
  requirementId: "r-lot",
  key: "REQ-7",
  title: "Lot tracking for recalls",
  status: "approved",
  label: "duplicate",
  score: 0.88,
  codeLinks: [
    {
      mappingId: "m-a",
      filePath: "a.ts",
      startLine: 1,
      endLine: 2,
      source: "semantic",
      freshness: "fresh",
    },
    {
      mappingId: "m-b",
      filePath: "b.ts",
      startLine: 1,
      endLine: 2,
      source: "semantic",
      freshness: "moved",
    },
    {
      mappingId: "m-c",
      filePath: "c.ts",
      startLine: 1,
      endLine: 2,
      source: "semantic",
      freshness: "stale",
    },
  ],
});
const SERIAL = item({ requirementId: "r-serial", title: "Track serial numbers", label: "related" });
/** #1902 — LOT, holding one more link it borrowed itself from a similar requirement. */
const LOT_WITH_BORROWED = {
  ...LOT,
  codeLinks: [
    ...LOT.codeLinks,
    {
      mappingId: "m-d",
      filePath: "d.ts",
      startLine: 1,
      endLine: 2,
      source: "similar-requirement",
      freshness: "fresh" as const,
    },
  ],
};

/** #1914 — LOT, holding two links into one file: one file, not two. */
const LOT_ONE_FILE = {
  ...LOT,
  codeLinks: [
    LOT.codeLinks[0]!,
    { ...LOT.codeLinks[0]!, mappingId: "m-a2", startLine: 40, endLine: 55 },
  ],
};

/** The fake server's routes. */
function route(path: string, opts: { method?: string; body?: unknown } = {}) {
  if (path === `/projects/${P}/requirements/${SELF}/similar` && !opts.method) {
    return {
      items: server.items.map((i) => ({
        ...i,
        notDuplicate: server.dismissed.has(i.requirementId),
        linkedAsDuplicate: server.linked.has(i.requirementId),
      })),
    };
  }
  const dismiss = path.match(/\/similar\/([^/]+)\/not-duplicate$/);
  if (dismiss && opts.method === "POST") {
    server.dismissed.add(dismiss[1]!);
    return { notDuplicate: true };
  }
  if (path === `/requirements/${SELF}/links` && opts.method === "POST") {
    server.linked.add((opts.body as { targetRequirementId: string }).targetRequirementId);
    return {};
  }
  throw new Error(`unexpected ${opts.method ?? "GET"} ${path}`);
}

function mountPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SimilarRequirementsPanel projectId={P} requirementId={SELF} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  server.dismissed.clear();
  server.linked.clear();
  server.items = [LOT, SERIAL];
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) =>
    route(path, opts),
  );
});

describe("SimilarRequirementsPanel (#1838)", () => {
  it("lists each similar requirement with its label in words, status, link and code-link freshness", async () => {
    mountPanel();
    const rows = await screen.findAllByTestId("similar-requirement");
    expect(rows).toHaveLength(2);
    const lot = within(rows[0]!);
    expect(lot.getByText("Likely duplicate")).toBeInTheDocument();
    expect(lot.getByText("approved")).toBeInTheDocument();
    expect(lot.getByText("3 code links: 2 fresh, 1 stale")).toBeInTheDocument();
    expect(lot.getByRole("link", { name: "REQ-7 Lot tracking for recalls" })).toHaveAttribute(
      "href",
      "/projects/p1/analysis?analysisId=a-1&requirementId=r-lot",
    );
    expect(within(rows[1]!).getByText("Related")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("No code links")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(`/projects/${P}/requirements/${SELF}/similar`, {
      params: { limit: 5 },
      signal: expect.any(AbortSignal),
    });
  });

  it("warns about a likely duplicate, with named actions", async () => {
    mountPanel();
    const warning = await screen.findByTestId("duplicate-warning");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent(
      "REQ-7 Lot tracking for recalls looks like the same requirement (it already links to 3 files)",
    );
    expect(
      screen.getByRole("button", { name: "Mark as duplicate of REQ-7 Lot tracking for recalls" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Not a duplicate of REQ-7 Lot tracking for recalls" }),
    ).toBeInTheDocument();
    // Only the duplicate warns.
    expect(screen.getAllByTestId("duplicate-warning")).toHaveLength(1);
  });

  it("counts a link the similar requirement borrowed apart, never as code it links (#1902)", async () => {
    server.items = [LOT_WITH_BORROWED, SERIAL];
    mountPanel();
    const [lot] = await screen.findAllByTestId("similar-requirement");
    expect(
      within(lot!).getByText("4 code links: 2 fresh, 1 stale, 1 borrowed"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("duplicate-warning")).toHaveTextContent(
      "looks like the same requirement (it already links to 3 files)",
    );
  });

  it("counts the files the duplicate links, not its links (#1914)", async () => {
    server.items = [LOT_ONE_FILE];
    mountPanel();
    expect(await screen.findByTestId("duplicate-warning")).toHaveTextContent(
      "looks like the same requirement (it already links to 1 file).",
    );
  });

  it("'Not a duplicate' stays answered after a full reload: the server says so", async () => {
    const user = userEvent.setup();
    const first = mountPanel();
    await user.click(await screen.findByRole("button", { name: /^Not a duplicate of REQ-7/ }));
    expect(apiFetch).toHaveBeenCalledWith(
      `/projects/${P}/requirements/${SELF}/similar/r-lot/not-duplicate`,
      { method: "POST" },
    );
    await waitFor(() => expect(screen.queryByTestId("duplicate-warning")).toBeNull());

    // A reload: everything client-side is gone; only the server remembers.
    first.unmount();
    apiFetch.mockClear();
    mountPanel();
    expect(await screen.findAllByTestId("similar-requirement")).toHaveLength(2);
    expect(apiFetch).toHaveBeenCalledWith(
      `/projects/${P}/requirements/${SELF}/similar`,
      expect.anything(),
    );
    expect(screen.queryByTestId("duplicate-warning")).toBeNull();
  });

  it("'Mark as duplicate' creates the duplicates link and the warning goes", async () => {
    const user = userEvent.setup();
    mountPanel();
    await user.click(await screen.findByRole("button", { name: /^Mark as duplicate of REQ-7/ }));
    expect(apiFetch).toHaveBeenCalledWith(`/requirements/${SELF}/links`, {
      method: "POST",
      body: { targetRequirementId: "r-lot", type: "duplicates" },
    });
    await waitFor(() => expect(screen.queryByTestId("duplicate-warning")).toBeNull());
  });

  it("says when the project has nothing similar, and when the lookup failed", async () => {
    server.items = [];
    const view = mountPanel();
    expect(await screen.findByTestId("similar-requirements-empty")).toHaveTextContent(EMPTY_TEXT);
    view.unmount();
    apiFetch.mockRejectedValue(new Error("down"));
    mountPanel();
    expect(
      await screen.findByText("Similar requirements could not be loaded."),
    ).toBeInTheDocument();
  });
});

describe("DraftSimilarRequirements (#1838)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const draftCalls = () =>
    apiFetch.mock.calls.filter(([path]) => path === `/projects/${P}/requirements/similar`);

  it("looks the draft up only after typing pauses, and cancels the request when the text changes", async () => {
    let resolveFirst!: (v: unknown) => void;
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    const view = render(
      <DraftSimilarRequirements projectId={P} text="Track batch numbers on receipt" />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS - 1);
    });
    expect(draftCalls()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(draftCalls()).toHaveLength(1);
    const [, firstOpts] = draftCalls()[0]!;
    expect(firstOpts).toMatchObject({
      method: "POST",
      body: { text: "Track batch numbers on receipt", limit: 5 },
    });
    const firstSignal = (firstOpts as { signal: AbortSignal }).signal;
    expect(firstSignal.aborted).toBe(false);

    // The analyst keeps typing while the first request is in flight.
    apiFetch.mockResolvedValueOnce({ items: [LOT] });
    view.rerender(
      <DraftSimilarRequirements projectId={P} text="Track batch numbers on receipt and dispatch" />,
    );
    expect(firstSignal.aborted).toBe(true);
    // Its answer arrives late, for text that has changed: it is not shown.
    await act(async () => {
      resolveFirst({ items: [SERIAL] });
      await Promise.resolve();
    });
    expect(screen.queryByText("Track serial numbers")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    });
    expect(draftCalls()).toHaveLength(2);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Before you add this: REQ-7 Lot tracking for recalls looks like a duplicate (it already links to 3 files).",
    );
  });

  it("the draft's duplicate warning counts only the code the duplicate links of its own (#1902)", async () => {
    apiFetch.mockResolvedValue({ items: [LOT_WITH_BORROWED] });
    render(<DraftSimilarRequirements projectId={P} text="Track batch numbers on receipt" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Before you add this: REQ-7 Lot tracking for recalls looks like a duplicate (it already links to 3 files).",
    );
  });

  it("the draft's duplicate warning counts files, not links (#1914)", async () => {
    apiFetch.mockResolvedValue({ items: [LOT_ONE_FILE] });
    render(<DraftSimilarRequirements projectId={P} text="Track batch numbers on receipt" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Before you add this: REQ-7 Lot tracking for recalls looks like a duplicate (it already links to 1 file).",
    );
  });

  it("does not look up a draft too short to compare, and shows the empty state", async () => {
    const view = render(<DraftSimilarRequirements projectId={P} text="Track" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);
    });
    expect(draftCalls()).toHaveLength(0);
    expect(view.container).toBeEmptyDOMElement();

    apiFetch.mockResolvedValueOnce({ items: [] });
    view.rerender(<DraftSimilarRequirements projectId={P} text="Track batch numbers on receipt" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    });
    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
  });
});

describe("codeLinkSummary", () => {
  it("counts moved as fresh and names links not yet checked", () => {
    expect(codeLinkSummary([])).toBe("No code links");
    expect(
      codeLinkSummary([
        {
          mappingId: "m-1",
          filePath: "a",
          startLine: null,
          endLine: null,
          source: "s",
          freshness: "unverified",
        },
      ]),
    ).toBe("1 code link: 0 fresh, 0 stale, 1 not yet checked");
  });

  it("counts a borrowed link apart, whatever its freshness (#1902)", () => {
    const link = (source: string, freshness: "fresh" | "stale" | "unverified") => ({
      mappingId: `m-${source}-${freshness}`,
      filePath: "a",
      startLine: null,
      endLine: null,
      source,
      freshness,
    });
    expect(
      codeLinkSummary([
        link("manual", "fresh"),
        link("similar-requirement", "fresh"),
        link("similar-requirement", "unverified"),
      ]),
    ).toBe("3 code links: 1 fresh, 0 stale, 2 borrowed");
  });
});
