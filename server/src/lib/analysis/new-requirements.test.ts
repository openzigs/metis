/**
 * Issue #768 — parsing the operator's free-text "new requirements" into
 * first-class requirement candidates, and merging them with the document
 * agent's extracted requirements.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractNewRequirementCandidates,
  mergeRequirementSets,
  newRequirementId,
} from "./new-requirements.js";
import { __resetConfigSingleton } from "../config/config-service.js";

beforeEach(() => {
  delete process.env.ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES;
  __resetConfigSingleton();
});
afterEach(() => {
  delete process.env.ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES;
  __resetConfigSingleton();
});

describe("newRequirementId", () => {
  it("mints the NR-* namespace 1-based, matching #735's affected-code candidate ids", () => {
    expect(newRequirementId(0)).toBe("NR-1");
    expect(newRequirementId(7)).toBe("NR-8");
  });
});

describe("extractNewRequirementCandidates", () => {
  it("splits a bullet list into one candidate per bullet", async () => {
    const candidates = await extractNewRequirementCandidates(
      ["- The API must expose /api/status.", "- Analyses must emit an audit event."].join("\n"),
    );

    expect(candidates).toEqual([
      { id: "NR-1", text: "The API must expose /api/status." },
      { id: "NR-2", text: "Analyses must emit an audit event." },
    ]);
  });

  it("treats each paragraph as one candidate", async () => {
    const candidates = await extractNewRequirementCandidates(
      "Add a health endpoint.\n\nAdd an audit event.",
    );

    expect(candidates.map((c) => c.id)).toEqual(["NR-1", "NR-2"]);
    expect(candidates[1].text).toBe("Add an audit event.");
  });

  it("returns none for empty / whitespace-only / undefined input (mode stays single-shot)", async () => {
    expect(await extractNewRequirementCandidates(undefined)).toEqual([]);
    expect(await extractNewRequirementCandidates(null)).toEqual([]);
    expect(await extractNewRequirementCandidates("")).toEqual([]);
    expect(await extractNewRequirementCandidates("   \n\n  ")).toEqual([]);
  });

  it("caps the candidate count (shared with the #735 mapping cap)", async () => {
    const text = Array.from({ length: 12 }, (_, i) => `- Requirement number ${i}.`).join("\n");

    const capped = await extractNewRequirementCandidates(text, 3);
    expect(capped.map((c) => c.id)).toEqual(["NR-1", "NR-2", "NR-3"]);

    // Same knob the affected-code mapping reads, so ids never diverge between the
    // requirement set and its blast-radius mapping.
    process.env.ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES = "2";
    __resetConfigSingleton();
    expect(await extractNewRequirementCandidates(text)).toHaveLength(2);
  });

  it("defaults to 8 candidates", async () => {
    const text = Array.from({ length: 12 }, (_, i) => `- Requirement number ${i}.`).join("\n");
    expect(await extractNewRequirementCandidates(text)).toHaveLength(8);
  });
});

describe("mergeRequirementSets", () => {
  const doc = [{ id: "REQ-001", text: "The system must log every login." }];

  it("appends new-requirement candidates after the document requirements", () => {
    const merged = mergeRequirementSets(doc, [{ id: "NR-1", text: "Add /api/status." }]);

    expect(merged).toEqual([
      { id: "REQ-001", text: "The system must log every login." },
      { id: "NR-1", text: "Add /api/status." },
    ]);
  });

  it("is byte-identical to the document set when no new requirements are supplied", () => {
    expect(mergeRequirementSets(doc, [])).toEqual(doc);
  });

  it("works with no document requirements at all (the #768 repro)", () => {
    const merged = mergeRequirementSets([], [{ id: "NR-1", text: "Add /api/status." }]);
    expect(merged).toEqual([{ id: "NR-1", text: "Add /api/status." }]);
  });

  it("drops a candidate that merely restates a document requirement (no double-counting)", () => {
    const merged = mergeRequirementSets(doc, [
      { id: "NR-1", text: "the system must log every login" }, // same text, re-punctuated
      { id: "NR-2", text: "Add /api/status." },
    ]);

    expect(merged.map((r) => r.id)).toEqual(["REQ-001", "NR-2"]);
  });

  it("de-duplicates repeated candidates against each other", () => {
    const merged = mergeRequirementSets(
      [],
      [
        { id: "NR-1", text: "Add /api/status." },
        { id: "NR-2", text: "add /api/status" },
      ],
    );

    expect(merged.map((r) => r.id)).toEqual(["NR-1"]);
  });

  it("drops a candidate the DOCUMENT agent echoed back in spec voice (the #768 double-count risk)", () => {
    // The operator's free text is also shown to the document agent, which #750's
    // extraction prompt can lift into `requirements[]` — usually REPHRASED. The
    // same requirement must not be investigated twice.
    const merged = mergeRequirementSets(
      [
        {
          id: "REQ-001",
          text: "The system SHALL rate limit the AI chat endpoint to 20 requests per minute per user.",
        },
      ],
      [
        {
          id: "NR-1",
          text: "Rate limit the AI chat endpoint to 20 requests per minute per user.",
        },
        { id: "NR-2", text: "Publishing a document must record an audit event." },
      ],
    );

    expect(merged.map((r) => r.id)).toEqual(["REQ-001", "NR-2"]);
  });

  it("drops a candidate a document requirement merely wraps in extra framing", () => {
    const merged = mergeRequirementSets(
      [{ id: "REQ-001", text: "REQ-1: Add rate limiting to the AI chat endpoint." }],
      [{ id: "NR-1", text: "Add rate limiting to the AI chat endpoint" }],
    );

    expect(merged.map((r) => r.id)).toEqual(["REQ-001"]);
  });

  it("keeps a requirement that only SHARES A SUBJECT with a document requirement", () => {
    // Same endpoint, different requirement — collapsing these would silently drop
    // what the user asked for, so the overlap bar stays high.
    const merged = mergeRequirementSets(
      [{ id: "REQ-001", text: "Add rate limiting to the AI chat endpoint." }],
      [{ id: "NR-1", text: "Add response caching to the AI chat endpoint." }],
    );

    expect(merged.map((r) => r.id)).toEqual(["REQ-001", "NR-1"]);
  });

  it("keeps differently-worded requirements that mean the same thing (conservative on purpose)", () => {
    const merged = mergeRequirementSets(doc, [
      { id: "NR-1", text: "Every login attempt must be written to the audit log." },
    ]);

    expect(merged).toHaveLength(2);
  });
});
