/**
 * Issue #1203 — the review card marks pinned acceptance criteria that one
 * grouped item wrote for several requirements, and links to the others.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/history-api", () => ({
  historyApi: { list: vi.fn(), restore: vi.fn(), export: vi.fn() },
}));

import { historyApi } from "@/lib/history-api";
import { ReviewItemCard } from "@/components/reviews/ReviewItemCard";
import type { ReviewItem } from "@/lib/reviews-api";

const historyListMock = historyApi.list as unknown as ReturnType<typeof vi.fn>;
const GROUP = ["Logging out ends every session.", "A reset ends every session."];

const RECORD = {
  requirementId: "req-1",
  structuredId: "REQ-1",
  sharedWith: [
    { structuredId: "REQ-2", title: "Flush on reset", requirementId: "req-2", approved: true },
    { structuredId: "REQ-3", title: "Flush on revoke", requirementId: "req-3", approved: true },
  ],
  sharedCriteria: GROUP,
  promotedCriteria: GROUP,
};

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "item-1",
    requirementId: "req-1",
    generatedDocumentId: null,
    pinnedVersion: 0,
    requirement: { id: "req-1", title: "Flush on logout", version: 0 },
    generatedDocument: null,
    sharedCriteria: { projectId: "proj-1", analysisId: "an-1", record: RECORD },
    ...over,
  };
}

function pinCriteria(criteria: string[]): void {
  historyListMock.mockResolvedValue({
    versions: [],
    total: 0,
    page: 1,
    pageSize: 100,
    currentVersion: 0,
    original: {
      version: 0,
      source: "current" as const,
      snapshot: { title: "Flush on logout", acceptanceCriteria: JSON.stringify(criteria) },
    },
  });
}

function renderCard(it: ReviewItem): void {
  const Wrapper = makeWrapper({});
  render(
    <Wrapper>
      <ReviewItemCard item={it} />
    </Wrapper>,
  );
}

beforeEach(() => {
  historyListMock.mockReset();
});

describe("ReviewItemCard — shared criteria (#1203)", () => {
  it("notes pinned criteria that are still the promoted ones, linking each sibling's card", async () => {
    pinCriteria(GROUP);
    renderCard(item());

    const note = await screen.findByTestId("shared-criteria-req-1");
    expect(note).toHaveTextContent(
      "Shared with Flush on reset and Flush on revoke — the analysis wrote these acceptance criteria for the group; edit any that don't apply.",
    );
    expect(
      within(note)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual([
      "/projects/proj-1/analysis?analysisId=an-1&requirementId=req-2",
      "/projects/proj-1/analysis?analysisId=an-1&requirementId=req-3",
    ]);
  });

  it("says nothing when the pinned criteria were edited", async () => {
    pinCriteria([GROUP[0]!, "Edited by the analyst."]);
    renderCard(item());

    expect(await screen.findByTestId("review-item-criteria")).toBeInTheDocument();
    expect(screen.queryByTestId("shared-criteria-req-1")).toBeNull();
  });

  it("says nothing for an item with no record", async () => {
    pinCriteria(GROUP);
    renderCard(item({ sharedCriteria: null }));

    expect(await screen.findByTestId("review-item-criteria")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("marks the shared criteria when some are the requirement's own", async () => {
    const own = [...GROUP, "Own criterion."];
    pinCriteria(own);
    renderCard(
      item({
        sharedCriteria: {
          projectId: "proj-1",
          analysisId: "an-1",
          record: { ...RECORD, promotedCriteria: own },
        },
      }),
    );

    const list = await screen.findByTestId("review-item-criteria");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([`${GROUP[0]}(shared)`, `${GROUP[1]}(shared)`, "Own criterion."]);
  });
});
