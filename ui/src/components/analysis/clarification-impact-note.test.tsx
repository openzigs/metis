/**
 * Issue #1116 (AC3) — the UI must state what a clarification answer does, and
 * what it does not do. The live incident had the user answer 14 questions, watch
 * the approval panel improve, and receive published issues containing none of
 * it — with nothing on screen distinguishing the two outcomes.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClarificationImpactNote } from "@/components/analysis/EnhancementResults";

const base = {
  answeredCount: 14,
  appliedCount: 12,
  unattributedCount: 2,
  requirementsUpdated: 5,
  requirementsAvailable: true,
  updatedAt: "2026-07-28T00:00:00.000Z",
};

describe("ClarificationImpactNote", () => {
  it("renders nothing before any question is answered", () => {
    const { container } = render(<ClarificationImpactNote application={undefined} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<ClarificationImpactNote application={{ ...base, answeredCount: 0 }} />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it("says how many answers reached the requirements that get published", () => {
    render(<ClarificationImpactNote application={base} />);
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /12 of 14 answers were written into the saved requirements/,
    );
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(/published issues/);
  });

  it("names the answers that will NOT appear in a published issue", () => {
    render(<ClarificationImpactNote application={base} />);
    expect(screen.getByTestId("clarification-unattributed")).toHaveTextContent(
      /2 answers could not be matched to a saved requirement/,
    );
  });

  it("omits the exclusion warning when every answer landed", () => {
    render(
      <ClarificationImpactNote application={{ ...base, appliedCount: 14, unattributedCount: 0 }} />,
    );
    expect(screen.queryByTestId("clarification-unattributed")).toBeNull();
  });

  it("explains the wait instead of implying loss while approval withholds the rows", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          requirementsAvailable: false,
          appliedCount: 0,
          requirementsUpdated: 0,
        }}
      />,
    );
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /awaiting approval\. When they are promoted, each answer is written into the requirement it matches/,
    );
  });

  // Issue #979 — the walkthrough saw "written into them when promoted" next to
  // "28 answers could not be matched to a saved requirement…": before promotion
  // there is no saved requirement, so every answer counts as unmatched.
  it("does not also claim the answers could not be matched while approval withholds the rows", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          answeredCount: 28,
          appliedCount: 0,
          unattributedCount: 28,
          requirementsUpdated: 0,
          requirementsAvailable: false,
          answers: [{ questionId: "q1", question: "Which format?", requirementTitle: null }],
        }}
      />,
    );
    expect(screen.queryByTestId("clarification-unattributed")).toBeNull();
    expect(screen.queryByTestId("clarification-unmatched-list")).toBeNull();
    expect(screen.getByTestId("clarification-impact")).not.toHaveTextContent(
      /could not be matched/,
    );
  });

  it("lists which answers were applied, and to which requirement", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          answers: [
            { questionId: "q1", question: "Which format?", requirementTitle: "Export feeds" },
            { questionId: "q2", question: "Which locale?", requirementTitle: null },
          ],
        }}
      />,
    );
    const applied = screen.getByTestId("clarification-applied-list");
    expect(applied).toHaveTextContent(/Which format\?\s*→\s*Export feeds/);
    expect(applied).not.toHaveTextContent(/Which locale/);
    const unmatched = screen.getByTestId("clarification-unmatched-list");
    expect(unmatched).toHaveTextContent(/Which locale\?/);
    expect(unmatched).not.toHaveTextContent(/Which format/);
  });

  it("#1162 — says which answers were not written because a Clarifications section was edited, and how to fix it", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          appliedCount: 11,
          unattributedCount: 2,
          blockEditedCount: 1,
          answers: [
            {
              questionId: "q3",
              question: "Which rate?",
              requirementTitle: null,
              notApplied: { reason: "clarification-block-edited", requirementTitle: "Show prices" },
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("clarification-block-edited")).toHaveTextContent(
      /1 answer was not written because the Clarifications section of its requirement was edited\. Restore its start and end markers, or delete the section/,
    );
    expect(screen.getByTestId("clarification-unmatched-list")).toHaveTextContent(
      /Which rate\?\s*\(Clarifications section of “Show prices” was edited\)/,
    );
  });

  it("#1162 — says why an answer was not written when its requirement changed or was deleted", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          appliedCount: 10,
          notWrittenCount: 2,
          answers: [
            {
              questionId: "q4",
              question: "Which currency?",
              requirementTitle: null,
              notApplied: {
                reason: "requirement-changed-during-write",
                requirementTitle: "Prices",
              },
            },
            {
              questionId: "q5",
              question: "Which locale?",
              requirementTitle: null,
              notApplied: { reason: "requirement-deleted", requirementTitle: "Locales" },
            },
          ],
        }}
      />,
    );
    const list = screen.getByTestId("clarification-unmatched-list");
    expect(list).toHaveTextContent(
      /Which currency\?\s*\(“Prices” kept changing while the answers were written/,
    );
    expect(list).toHaveTextContent(/Which locale\?\s*\(“Locales” was deleted\)/);
  });

  it("#1225 — an unknown not-applied reason gets a fallback label instead of crashing", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          answers: [
            {
              questionId: "q6",
              question: "Which region?",
              requirementTitle: null,
              notApplied: {
                // A reason written by a newer server, read after a rollback.
                reason: "a-reason-from-a-newer-server" as "requirement-deleted",
                requirementTitle: "Regions",
              },
            },
          ],
        }}
      />,
    );
    // Anchored: the whole reason, not a substring of it.
    expect(screen.getByTestId("clarification-not-applied-reason")).toHaveTextContent(
      /^\(“Regions” could not be updated\)$/,
    );
  });

  it("#1225 — says how many answers were not written, why, and what to do next", () => {
    const next =
      "Submit the answers again to retry; a deleted requirement is not restored, so nothing is " +
      "written into it.";
    const { rerender } = render(
      <ClarificationImpactNote application={{ ...base, notWrittenCount: 2 }} />,
    );
    // Exact: the whole warning, not a substring of it.
    expect(screen.getByTestId("clarification-not-written").textContent).toBe(
      "2 answers were not written because their requirements changed or were deleted while the " +
        `answers were being saved. ${next}`,
    );
    rerender(<ClarificationImpactNote application={{ ...base, notWrittenCount: 1 }} />);
    expect(screen.getByTestId("clarification-not-written").textContent).toBe(
      "1 answer was not written because its requirement changed or was deleted while the " +
        `answers were being saved. ${next}`,
    );
    rerender(<ClarificationImpactNote application={{ ...base, notWrittenCount: 0 }} />);
    expect(screen.queryByTestId("clarification-not-written")).toBeNull();
  });

  it("#1162 — no block-edited warning when every matched answer was written", () => {
    render(<ClarificationImpactNote application={{ ...base, blockEditedCount: 0 }} />);
    expect(screen.queryByTestId("clarification-block-edited")).toBeNull();
  });

  it("shows no per-answer lists for metadata written before #979", () => {
    render(<ClarificationImpactNote application={base} />);
    expect(screen.queryByTestId("clarification-applied-list")).toBeNull();
    expect(screen.queryByTestId("clarification-unmatched-list")).toBeNull();
  });

  it("states the enrichment that is deliberately NOT published", () => {
    render(<ClarificationImpactNote application={base} />);
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /is not copied into published issues — the answers are, verbatim, each marked/,
    );
  });

  // Issue #1000 — an unedited METIS suggestion is not the user's own answer.
  it("says who wrote each applied answer", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          answers: [
            {
              questionId: "q1",
              question: "Which format?",
              requirementTitle: "Export feeds",
              provenance: "suggested",
            },
            {
              questionId: "q2",
              question: "Which locale?",
              requirementTitle: "Export feeds",
              provenance: "edited",
            },
            {
              questionId: "q3",
              question: "Which size?",
              requirementTitle: "Export feeds",
              provenance: "typed",
            },
            { questionId: "q4", question: "Legacy?", requirementTitle: "Export feeds" },
          ],
        }}
      />,
    );
    const tags = screen.getAllByTestId("clarification-answer-provenance");
    expect(tags.map((t) => t.textContent?.trim())).toEqual([
      "(METIS suggestion, accepted unchanged)",
      "(METIS suggestion, edited)",
      "(typed by you)",
    ]);
  });

  it("uses singular wording for a single answer", () => {
    render(
      <ClarificationImpactNote
        application={{ ...base, answeredCount: 1, appliedCount: 1, unattributedCount: 0 }}
      />,
    );
    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /1 of 1 answer was written/,
    );
  });
});

describe("ClarificationImpactNote — #1204 answers refused because the match was ambiguous", () => {
  const tiedAnswer = (questionId: string, ambiguousBetween: string[]) => ({
    questionId,
    question: `Question ${questionId}?`,
    requirementTitle: null,
    ambiguousBetween,
  });

  it("says so in the existing warning and names the requirements each answer fitted", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          unattributedCount: 2,
          ambiguousCount: 1,
          answers: [
            tiedAnswer("q1", ["Mark all as read", "Mark older entries read"]),
            { questionId: "q2", question: "Other?", requirementTitle: null },
          ],
        }}
      />,
    );
    const warning = screen.getByTestId("clarification-unattributed");
    expect(warning).toHaveTextContent(
      /1 of them matched more than one saved requirement equally well, so none was chosen/,
    );
    const list = screen.getByTestId("clarification-ambiguous");
    expect(list).toHaveTextContent(
      "Question q1? → fits “Mark all as read” and “Mark older entries read” equally well",
    );
    expect(list).not.toHaveTextContent("Other?");
  });

  it("says “They” when every unmatched answer was ambiguous, and handles one named row", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          unattributedCount: 2,
          ambiguousCount: 2,
          answers: [tiedAnswer("q1", ["A", "B", "C"]), tiedAnswer("q2", ["Export orders"])],
        }}
      />,
    );
    expect(screen.getByTestId("clarification-unattributed")).toHaveTextContent(
      /They matched more than one saved requirement/,
    );
    const list = screen.getByTestId("clarification-ambiguous");
    expect(list).toHaveTextContent("fits “A”, “B” and “C” equally well");
    expect(list).toHaveTextContent("fits “Export orders” and another requirement equally well");
  });

  it("says “It” for a single ambiguous answer", () => {
    render(
      <ClarificationImpactNote
        application={{
          ...base,
          unattributedCount: 1,
          ambiguousCount: 1,
          answers: [tiedAnswer("q1", ["A", "B"])],
        }}
      />,
    );
    expect(screen.getByTestId("clarification-unattributed")).toHaveTextContent(
      /It matched more than one saved requirement/,
    );
  });

  it("adds nothing for unmatched answers that were not ambiguous", () => {
    render(<ClarificationImpactNote application={base} />);
    expect(screen.queryByTestId("clarification-ambiguous")).toBeNull();
    expect(screen.getByTestId("clarification-unattributed")).not.toHaveTextContent(/equally well/);
  });
});
