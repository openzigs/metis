/** #2326 — the `--index-fault` arm's fixture and its scorer. */
import { describe, expect, it } from "vitest";
import {
  effectiveSourceIngestStatus,
  settledStatus,
} from "../../connectors/source-ingest-state.js";
import {
  indexFaultState,
  mentionsIndexProblem,
  parseIndexFault,
  summarizeIndexFault,
} from "./index-fault.js";

const NOW = new Date("2026-11-12T06:00:00.000Z");

describe("indexFaultState", () => {
  it("records a failed last run, which chat reads as failed", () => {
    const s = indexFaultState("failed", NOW);
    expect(effectiveSourceIngestStatus(s, NOW.getTime())).toBe("failed");
    expect(s.error).toMatch(/ETIMEDOUT/);
  });

  it("records a partial last run (files past the limit), which chat reads as partial", () => {
    const s = indexFaultState("partial", NOW);
    expect(effectiveSourceIngestStatus(s, NOW.getTime())).toBe("partial");
    expect(settledStatus(s)).toBe("partial");
    expect(s.skipped.cap).toBe(300);
    expect(s.error).toBeUndefined();
  });

  it("parses the two faults only", () => {
    expect(parseIndexFault("failed")).toBe("failed");
    expect(parseIndexFault("partial")).toBe("partial");
    expect(() => parseIndexFault("broken")).toThrow(/failed or partial/);
  });
});

describe("mentionsIndexProblem", () => {
  it.each([
    "The project's index is partial, so this may simply not be indexed.",
    "Note: the last indexing run failed, so the code may be missing.",
    "I could not find it, but the repository was only partially indexed.",
    "Indexing did not finish for acme-app; treat the absence with caution.",
    "Because the ingest failed, these results may be out of date.",
  ])("counts %s", (text) => {
    expect(mentionsIndexProblem(text)).toBe(true);
  });

  it.each([
    "The sources don't show this: no rule for refresh intervals appears.",
    "The feed refresh interval is 60 minutes (internal/config/options.go:120).",
    "The handler failed requests are retried. Indexes in the database are created at startup.",
  ])("does not count %s", (text) => {
    expect(mentionsIndexProblem(text)).toBe(false);
  });
});

describe("summarizeIndexFault", () => {
  it("counts the answers that name the index, and the abstentions that did not", () => {
    expect(
      summarizeIndexFault("partial", [
        { response: "The index is partial; it may be there.", behaviour: "abstain" },
        { response: "The sources don't show this.", behaviour: "abstain" },
        { response: "It is 60 minutes.", behaviour: "answer" },
        { response: "It is 60 minutes, though indexing failed.", behaviour: "answer" },
      ]),
    ).toEqual({ fault: "partial", mentioned: 2, abstained: 2, abstainedWithoutIndex: 1, of: 4 });
  });
});
