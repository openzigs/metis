/**
 * #2543 — the "N more questions" note counted only the questions a round wrote
 * and did not ask. The open ambiguities the round wrote no question for at all
 * (the server's cap on the ambiguities one round considers, #2534) went
 * uncounted, so on the last round the note understated what goes unasked. The
 * round now carries them (`notConsidered`) and the note says so.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ClarificationRound, ClarificationStatePayload } from "@/lib/analysis-api";
import { NotAskedNote } from "@/components/analysis/ClarificationDialog";

const state = (
  round: Partial<ClarificationRound>,
  over: Partial<ClarificationStatePayload> = {},
): ClarificationStatePayload => ({
  analysisId: "a1",
  currentRound: round.round ?? 1,
  maxRounds: 3,
  rounds: [{ round: 1, questions: [], answers: [], ...round }],
  resolvedAmbiguities: [],
  answeredAmbiguities: [],
  escalatedToSonnet: false,
  completed: false,
  ...over,
});

const note = () => screen.getByTestId("clarification-not-asked");

describe("NotAskedNote counts the ambiguities a round wrote no question for (#2543)", () => {
  it("says both counts while later rounds are left", () => {
    render(<NotAskedNote state={state({ notAsked: 16, notConsidered: 220 })} />);
    expect(note()).toHaveTextContent(
      "16 more questions of lower impact are waiting for the next round. " +
        "220 more open ambiguities have no question yet and are left for later rounds.",
    );
  });

  it("says, on the last round, that the left-out ambiguities were not asked about", () => {
    render(<NotAskedNote state={state({ round: 3, notAsked: 16, notConsidered: 22 })} />);
    expect(note()).toHaveTextContent(
      "16 more questions did not fit in the last round and were not asked. " +
        "22 more open ambiguities had no question written and were not asked about.",
    );
  });

  it("shows the note for left-out ambiguities alone, every question written having been asked", () => {
    render(<NotAskedNote state={state({ notConsidered: 1 })} />);
    expect(note()).toHaveTextContent(
      "1 more open ambiguity has no question yet and is left for later rounds.",
    );
    expect(note()).not.toHaveTextContent("question of lower impact");
  });

  it("says they were not asked about once the dialog is complete, in the singular", () => {
    render(<NotAskedNote state={state({ notConsidered: 1 }, { completed: true })} />);
    expect(note()).toHaveTextContent(
      "1 more open ambiguity had no question written and was not asked about.",
    );
    expect(note()).not.toHaveTextContent("later rounds");
  });

  it("keeps the questions-only note as it was when none was left out", () => {
    render(<NotAskedNote state={state({ notAsked: 2 })} />);
    expect(note().textContent).toBe(
      "2 more questions of lower impact are waiting for the next round.",
    );
  });

  it("says nothing when nothing goes unasked", () => {
    render(<NotAskedNote state={state({ notAsked: 0, notConsidered: 0 })} />);
    expect(screen.queryByTestId("clarification-not-asked")).toBeNull();
  });
});
