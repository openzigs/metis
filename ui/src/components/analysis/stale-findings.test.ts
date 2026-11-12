/**
 * #2222 — an analysis finding a requirement edited since the analysis was
 * synthesised from is marked stale where the analysis view lists it.
 */
import { describe, expect, it } from "vitest";
import { staleFindingNotes } from "./stale-findings";

describe("staleFindingNotes", () => {
  it("notes each finding of a requirement edited past its analysed version, once per requirement", () => {
    const notes = staleFindingNotes([
      {
        id: "r1",
        title: "Minimum password length",
        version: 2,
        analysedVersion: 0,
        evidenceFindingIds: ["f-1", "f-2"],
      },
      {
        id: "r2",
        title: "Reset page",
        version: 1,
        analysedVersion: 0,
        evidenceFindingIds: ["f-1"],
      },
      { id: "r3", title: "Current", version: 3, analysedVersion: 3, evidenceFindingIds: ["f-3"] },
      { id: "r4", title: "Old snapshot", version: 3, evidenceFindingIds: ["f-4"] },
    ]);
    expect(notes.get("f-1")).toEqual([
      {
        requirementId: "r1",
        text: "Stale: judged v0 of “Minimum password length”, which is now v2.",
      },
      { requirementId: "r2", text: "Stale: judged v0 of “Reset page”, which is now v1." },
    ]);
    expect(notes.get("f-2")).toEqual([
      {
        requirementId: "r1",
        text: "Stale: judged v0 of “Minimum password length”, which is now v2.",
      },
    ]);
    expect(notes.has("f-3")).toBe(false);
    expect(notes.has("f-4")).toBe(false);
  });

  it("#2281 — keeps a note per requirement when two share a title, each naming its own", () => {
    const twin = {
      title: "Same title",
      version: 1,
      analysedVersion: 0,
      evidenceFindingIds: ["f-1"],
    };
    const notes = staleFindingNotes([
      { id: "a", ...twin },
      { id: "b", ...twin },
    ]);
    expect(notes.get("f-1")?.map((n) => n.requirementId)).toEqual(["a", "b"]);
  });
});
