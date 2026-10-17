/**
 * Issue #1203 — a requirement whose acceptance criteria one grouped item wrote
 * for it and other requirements together says so on its card, and links to
 * those requirements; once the analyst edits the criteria, it stops.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SharedCriteriaRecord } from "@metis/shared";
import {
  RequirementCriteria,
  requirementCardHref,
  SharedCriteriaNote,
  sharedCriteriaMarks,
} from "@/components/analysis/SharedCriteriaNote";

const GROUP = ["Logging out ends every session.", "A reset ends every session."];
const TITLES: Record<string, string> = {
  rq_1: "Flush on logout",
  rq_2: "Flush on reset",
  rq_3: "Flush on revoke",
};
const sib = (id: string) => ({
  structuredId: `S-${id}`,
  title: TITLES[id]!,
  requirementId: id,
  approved: true,
});
const entry = (id: string, siblings: string[], promoted = GROUP): SharedCriteriaRecord => ({
  requirementId: id,
  structuredId: `S-${id}`,
  sharedWith: siblings.map(sib),
  sharedCriteria: GROUP,
  promotedCriteria: promoted,
});
/** One three-requirement item (rq_1..rq_3) and one single-requirement item (rq_4). */
const METADATA = {
  promotionMatching: {
    ambiguousCount: 0,
    ambiguous: [],
    shared: [
      entry("rq_1", ["rq_2", "rq_3"]),
      entry("rq_2", ["rq_1", "rq_3"]),
      entry("rq_3", ["rq_1", "rq_2"]),
    ],
    updatedAt: "2026-10-17T00:00:00.000Z",
  },
};

function renderCard(id: string, criteria: string[], metadata: unknown = METADATA) {
  return render(
    <div data-testid={`card-${id}`}>
      <RequirementCriteria
        metadata={metadata as Record<string, unknown>}
        requirementId={id}
        criteria={criteria}
        projectId="p 1"
        analysisId="an_1"
        titleOf={(rid) => (rid === "rq_3" ? "Revoke every token" : undefined)}
      />
    </div>,
  );
}

describe("RequirementCriteria (#1203)", () => {
  it("a three-requirement item puts a note on each card, linking the other two", () => {
    for (const id of ["rq_1", "rq_2", "rq_3"]) renderCard(id, GROUP);

    for (const [id, others] of [
      ["rq_1", ["rq_2", "rq_3"]],
      ["rq_2", ["rq_1", "rq_3"]],
      ["rq_3", ["rq_1", "rq_2"]],
    ] as const) {
      const note = screen.getByTestId(`shared-criteria-${id}`);
      expect(note).toHaveTextContent(
        /^Shared with .+ and .+ — the analysis wrote these acceptance criteria for the group; edit any that don't apply\.$/,
      );
      const links = within(note).getAllByRole("link");
      expect(links.map((l) => l.getAttribute("href"))).toEqual(
        others.map((o) => `/projects/p%201/analysis?analysisId=an_1&requirementId=${o}`),
      );
    }
    // A sibling is named by its current title when the page knows the row.
    expect(screen.getByTestId("shared-criteria-rq_1")).toHaveTextContent(
      "Shared with Flush on reset and Revoke every token —",
    );
  });

  it("a single-requirement item gets no note and no marks", () => {
    renderCard("rq_4", ["Subscriptions export as OPML."]);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("(shared)")).toBeNull();
  });

  it("says nothing once the analyst has edited the criteria", () => {
    renderCard("rq_1", [GROUP[0]!, "Edited by the analyst."]);
    expect(screen.queryByTestId("shared-criteria-rq_1")).toBeNull();
  });

  it("renders nothing for an older run or malformed metadata", () => {
    renderCard("rq_1", GROUP, { promotionMatching: { ambiguous: [] } });
    renderCard("rq_2", GROUP, { promotionMatching: { shared: [{ requirementId: "rq_2" }] } });
    renderCard("rq_3", GROUP, null);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("marks only the shared criteria when some are the requirement's own", () => {
    const own = [...GROUP, "Own criterion."];
    renderCard("rq_1", own, {
      promotionMatching: { ambiguous: [], shared: [entry("rq_1", ["rq_2"], own)] },
    });
    const items = within(screen.getByTestId("acceptance-criteria")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      `${GROUP[0]}(shared)`,
      `${GROUP[1]}(shared)`,
      "Own criterion.",
    ]);
    expect(screen.getByTestId("shared-criteria-rq_1")).toHaveTextContent(
      "The criteria marked “shared” are shared with Flush on reset —",
    );
  });
});

describe("SharedCriteriaNote", () => {
  it("names a sibling with no row as not approved, without a link", () => {
    const record: SharedCriteriaRecord = {
      ...entry("rq_1", []),
      sharedWith: [
        { structuredId: "S-9", title: "Rate limit", requirementId: null, approved: false },
        { structuredId: "S-8", title: "Legacy row", requirementId: null, approved: true },
      ],
    };
    render(<SharedCriteriaNote record={record} criteria={GROUP} hrefFor={() => "/x"} />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Shared with Rate limit (not approved) and Legacy row —");
    expect(within(note).queryByRole("link")).toBeNull();
  });

  it("names a sibling without a link when there is nowhere to go", () => {
    render(
      <SharedCriteriaNote
        record={entry("rq_1", ["rq_2"])}
        criteria={GROUP}
        hrefFor={() => undefined}
      />,
    );
    expect(within(screen.getByRole("note")).queryByRole("link")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("Shared with Flush on reset —");
  });

  it("renders nothing without a record", () => {
    const { container } = render(
      <SharedCriteriaNote record={null} criteria={GROUP} hrefFor={() => "/x"} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("separates three or more names with commas", () => {
    render(
      <SharedCriteriaNote
        record={{ ...entry("rq_9", ["rq_1", "rq_2", "rq_3"]) }}
        criteria={GROUP}
        hrefFor={() => undefined}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "Shared with Flush on logout, Flush on reset and Flush on revoke —",
    );
  });
});

describe("helpers", () => {
  it("builds the deep link the analysis page opens a card from", () => {
    expect(requirementCardHref("p", "a&b", "r")).toBe(
      "/projects/p/analysis?analysisId=a%26b&requirementId=r",
    );
  });

  it("marks nothing when every criterion is shared, or there is no record", () => {
    expect(sharedCriteriaMarks(entry("rq_1", ["rq_2"]), GROUP).size).toBe(0);
    expect(sharedCriteriaMarks(null, GROUP).size).toBe(0);
  });
});
