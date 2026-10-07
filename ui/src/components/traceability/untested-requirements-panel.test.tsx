/**
 * UntestedRequirementsPanel tests — #816 (Epic #812).
 *
 * The analysis Traceability tab's list of requirements that have mapped code
 * but no linked test: the "N of M" summary over requirements with mapped code,
 * the `noCode` count, links to each requirement card, "Load more" paging via
 * `nextCursor`, and the disabled / empty / error states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementTestGaps } from "@metis/shared";

const testGaps = vi.fn();
vi.mock("@/lib/traceability-api", () => ({
  traceabilityApi: { testGaps: (...args: unknown[]) => testGaps(...args) },
}));

import { UntestedRequirementsPanel, UNTESTED_PAGE_SIZE } from "./untested-requirements-panel";

function gap(id: string, title: string) {
  return {
    requirementId: id,
    title,
    analysisId: "an-1",
    reason: "no-test" as const,
    mappedFiles: 1,
  };
}

const PAGE_1: RequirementTestGaps = {
  total: 10,
  tested: 5,
  noCode: 3,
  untested: [gap("r-1", "OIDC role mapping"), gap("r-2", "Session expiry")],
  nextCursor: "r-2",
};
const PAGE_2: RequirementTestGaps = {
  ...PAGE_1,
  untested: [gap("r-3", "Audit log export")],
  nextCursor: null,
};

function renderPanel(enabled = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UntestedRequirementsPanel projectId="proj-1" analysisId="an-1" enabled={enabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("UntestedRequirementsPanel", () => {
  it("renders nothing and never fetches until the analysis completes", () => {
    renderPanel(false);
    expect(screen.queryByTestId("untested-requirements-panel")).toBeNull();
    expect(testGaps).not.toHaveBeenCalled();
  });

  it("shows a loading state", () => {
    testGaps.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("summarises over requirements with mapped code and links each untested one", async () => {
    testGaps.mockResolvedValue({ ...PAGE_1, nextCursor: null });
    renderPanel();

    const panel = await screen.findByTestId("untested-requirements-panel");
    expect(
      within(panel).getByRole("heading", { name: "Untested requirements" }),
    ).toBeInTheDocument();
    // M = total − noCode = 7.
    expect(await screen.findByTestId("untested-summary")).toHaveTextContent(
      "5 of 7 requirements with mapped code have a linked test",
    );
    expect(screen.getByTestId("untested-no-code")).toHaveTextContent(
      "3 requirements have no mapped code yet, so they are not counted",
    );
    const link = within(panel).getByRole("link", { name: "OIDC role mapping" });
    expect(link).toHaveAttribute(
      "href",
      "/projects/proj-1/analysis?analysisId=an-1&requirementId=r-1&tab=requirements",
    );
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(testGaps).toHaveBeenCalledWith("proj-1", {
      analysisId: "an-1",
      limit: UNTESTED_PAGE_SIZE,
      cursor: undefined,
    });
  });

  it("loads the next page through nextCursor and appends it", async () => {
    testGaps.mockResolvedValueOnce(PAGE_1).mockResolvedValueOnce(PAGE_2);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "Audit log export" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "OIDC role mapping" })).toBeInTheDocument();
    expect(testGaps).toHaveBeenLastCalledWith("proj-1", {
      analysisId: "an-1",
      limit: UNTESTED_PAGE_SIZE,
      cursor: "r-2",
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("says every requirement with mapped code is tested when none are untested", async () => {
    testGaps.mockResolvedValue({ total: 4, tested: 4, noCode: 0, untested: [], nextCursor: null });
    renderPanel();
    expect(await screen.findByTestId("untested-empty")).toHaveTextContent(
      "Every requirement with mapped code has a linked test.",
    );
    expect(screen.queryByTestId("untested-no-code")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("says nothing can be checked when no requirement has mapped code", async () => {
    testGaps.mockResolvedValue({ total: 2, tested: 0, noCode: 2, untested: [], nextCursor: null });
    renderPanel();
    expect(await screen.findByTestId("untested-empty")).toHaveTextContent(
      "No requirement has mapped code yet, so none can be checked for tests.",
    );
    expect(screen.queryByTestId("untested-summary")).toBeNull();
    expect(screen.queryByTestId("untested-no-code")).toBeNull();
  });

  it("uses the singular for a single no-code requirement", async () => {
    testGaps.mockResolvedValue({ total: 2, tested: 1, noCode: 1, untested: [], nextCursor: null });
    renderPanel();
    expect(await screen.findByTestId("untested-no-code")).toHaveTextContent(
      "1 requirement has no mapped code yet, so it is not counted",
    );
  });

  it("surfaces a load error", async () => {
    testGaps.mockRejectedValue(new Error("boom"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load untested requirements.",
    );
  });

  it("keeps loaded pages and shows an inline error when Load more fails", async () => {
    testGaps.mockResolvedValueOnce(PAGE_1).mockRejectedValueOnce(new Error("boom"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load more untested requirements. Try again.",
    );
    expect(screen.getByRole("link", { name: "OIDC role mapping" })).toBeInTheDocument();
    expect(screen.getByTestId("untested-summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });

  it("never lists an entry whose reason is no-code", async () => {
    testGaps.mockResolvedValue({
      total: 3,
      tested: 1,
      noCode: 0,
      untested: [gap("r-x", "Listed"), { ...gap("r-y", "Not listed"), reason: "no-code" as const }],
      nextCursor: null,
    });
    renderPanel();
    expect(await screen.findByRole("link", { name: "Listed" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Not listed" })).toBeNull();
  });
});
