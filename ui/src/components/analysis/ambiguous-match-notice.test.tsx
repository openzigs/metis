/**
 * Issue #1204 — a requirement promoted with no acceptance criteria because the
 * analysis could not tell which grouped item was its own says so on its card,
 * and lists those items with their criteria to copy across.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AmbiguousMatchNotice,
  findAmbiguousMatch,
} from "@/components/analysis/AmbiguousMatchNotice";

const LOGOUT = {
  title: "Flush sessions on logout",
  acceptanceCriteria: ["Logging out ends every session."],
};
const RESET = { title: "Flush sessions on password reset", acceptanceCriteria: [] };
const metadataWith = (candidates: unknown[]) => ({
  promotionMatching: {
    ambiguousCount: 1,
    ambiguous: [{ requirementId: "rq_1", structuredId: "REQ-1", candidates }],
    updatedAt: "2026-10-17T00:00:00.000Z",
  },
});

describe("AmbiguousMatchNotice", () => {
  it("names how many grouped items it could not tell apart, and lists them with their criteria", () => {
    render(<AmbiguousMatchNotice metadata={metadataWith([LOGOUT, RESET])} requirementId="rq_1" />);
    const notice = screen.getByTestId("ambiguous-match-rq_1");
    expect(notice).toHaveTextContent(
      "The analysis could not tell which of 2 grouped items belongs to this requirement",
    );
    expect(within(notice).getByText(LOGOUT.title)).toBeInTheDocument();
    expect(within(notice).getByText(LOGOUT.acceptanceCriteria[0]!)).toBeInTheDocument();
    expect(within(notice).getByText(RESET.title)).toBeInTheDocument();
    expect(notice).toHaveTextContent("This item has no acceptance criteria.");
  });

  it("words a single grouped item without “which of 1”", () => {
    render(<AmbiguousMatchNotice metadata={metadataWith([LOGOUT])} requirementId="rq_1" />);
    const notice = screen.getByTestId("ambiguous-match-rq_1");
    expect(notice).toHaveTextContent(
      "could not tell whether the grouped item below belongs to this requirement or to another one",
    );
    expect(notice).not.toHaveTextContent("which of 1");
  });

  it("renders nothing on another requirement's card, or without a record", () => {
    for (const [metadata, id] of [
      [metadataWith([LOGOUT]), "rq_2"],
      [{}, "rq_1"],
      [null, "rq_1"],
      [{ promotionMatching: "x" }, "rq_1"],
      [{ promotionMatching: { ambiguous: "x" } }, "rq_1"],
    ] as const) {
      const { container } = render(
        <AmbiguousMatchNotice
          metadata={metadata as Record<string, unknown> | null}
          requirementId={id}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });
});

describe("findAmbiguousMatch", () => {
  it("drops malformed candidates and criteria, and skips an entry left with none", () => {
    expect(findAmbiguousMatch(metadataWith([null, { nope: 1 }]), "rq_1")).toBeUndefined();
    const entry = findAmbiguousMatch(
      metadataWith([{ title: "Kept", acceptanceCriteria: ["ok", 3] }, 7]),
      "rq_1",
    );
    expect(entry?.candidates.map((c) => c.title)).toEqual(["Kept"]);
  });

  it("renders only the string criteria of a candidate", () => {
    render(
      <AmbiguousMatchNotice
        metadata={metadataWith([
          { title: "One", acceptanceCriteria: ["ok", 3] },
          { title: "Two", acceptanceCriteria: "not a list" },
        ])}
        requirementId="rq_1"
      />,
    );
    const notice = screen.getByTestId("ambiguous-match-rq_1");
    expect(within(notice).getByText("ok")).toBeInTheDocument();
    expect(within(notice).getAllByText("This item has no acceptance criteria.")).toHaveLength(1);
  });
});
