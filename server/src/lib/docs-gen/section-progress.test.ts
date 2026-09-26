import { describe, expect, it } from "vitest";
import {
  PHASE1_PROGRESS_SHARE,
  documentProgressPercent,
  monotonicPercent,
  phase1ProgressMessage,
  phase1ProgressPercent,
  sectionProgressMessage,
  sectionProgressPercent,
} from "./section-progress.js";

describe("sectionProgressPercent", () => {
  it("counts a finished section as done and a generating one as not yet done", () => {
    expect(sectionProgressPercent({ status: "done", index: 3, total: 7 })).toBe(43);
    expect(sectionProgressPercent({ status: "generating", index: 3, total: 7 })).toBe(29);
    expect(sectionProgressPercent({ status: "failed", index: 7, total: 7 })).toBe(100);
  });

  it("advances once per batch inside a batched section, monotonically", () => {
    const seen = [
      sectionProgressPercent({ status: "generating", index: 3, total: 7 }),
      ...Array.from({ length: 52 }, (_, i) =>
        sectionProgressPercent({
          status: "generating",
          index: 3,
          total: 7,
          batch: { done: i + 1, total: 52 },
        }),
      ),
      sectionProgressPercent({ status: "done", index: 3, total: 7 }),
    ];
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(new Set(seen).size).toBeGreaterThan(10);
    expect(seen[0]).toBe(29);
    expect(seen[seen.length - 1]).toBe(43);
  });

  it("tolerates a zero total and out-of-range batch counts", () => {
    expect(sectionProgressPercent({ status: "generating", index: 1, total: 0 })).toBe(0);
    expect(
      sectionProgressPercent({
        status: "generating",
        index: 1,
        total: 1,
        batch: { done: 9, total: 3 },
      }),
    ).toBe(100);
    expect(
      sectionProgressPercent({
        status: "generating",
        index: 1,
        total: 1,
        batch: { done: 1, total: 0 },
      }),
    ).toBe(0);
  });
});

describe("sectionProgressMessage", () => {
  it("names the batch while a batched section generates", () => {
    expect(
      sectionProgressMessage({
        section: "Rules",
        status: "generating",
        index: 3,
        total: 7,
        batch: { done: 4, total: 52 },
      }),
    ).toBe("Section 3/7: Rules (batch 4/52)");
    expect(sectionProgressMessage({ section: "Rules", status: "done", index: 3, total: 7 })).toBe(
      "Section 3/7: Rules",
    );
  });
});

describe("Phase 1 progress and the whole-document bar", () => {
  it("fills 0..60% over Phase 1's chunks, monotonically, and never past its share", () => {
    const seen = Array.from({ length: 553 }, (_, i) => phase1ProgressPercent(i, 552));
    expect(seen[0]).toBe(0);
    expect(seen[552]).toBe(PHASE1_PROGRESS_SHARE);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(new Set(seen).size).toBe(PHASE1_PROGRESS_SHARE + 1);
    expect(phase1ProgressPercent(900, 552)).toBe(PHASE1_PROGRESS_SHARE);
    expect(phase1ProgressPercent(3, 0)).toBe(0);
    expect(phase1ProgressMessage(212, 552)).toBe("Extracting facts: 212/552 chunks");
  });

  it("continues from Phase 1's share into Phase 2 without going backwards", () => {
    const phase1 = Array.from({ length: 11 }, (_, i) => phase1ProgressPercent(i, 10));
    const phase2 = [
      documentProgressPercent({ status: "generating", index: 1, total: 7 }),
      ...Array.from({ length: 10 }, (_, i) =>
        documentProgressPercent({
          status: "generating",
          index: 1,
          total: 7,
          batch: { done: i + 1, total: 10 },
        }),
      ),
      documentProgressPercent({ status: "done", index: 1, total: 7 }),
      documentProgressPercent({ status: "done", index: 7, total: 7 }),
    ];
    const all = [...phase1, ...phase2];
    for (let i = 1; i < all.length; i++) expect(all[i]).toBeGreaterThanOrEqual(all[i - 1]);
    expect(phase2[0]).toBe(PHASE1_PROGRESS_SHARE);
    expect(phase2[phase2.length - 1]).toBe(100);
  });
});

describe("monotonicPercent (#178)", () => {
  it("never reports less than it already has when a split grows a section's total", () => {
    const pct = monotonicPercent();
    const seen = [
      { done: 3, total: 4 },
      { done: 4, total: 6 }, // two cut-off batches split between finishes
      { done: 5, total: 6 },
      { done: 6, total: 6 },
    ].map((batch) =>
      pct(documentProgressPercent({ status: "generating", index: 1, total: 1, batch })),
    );
    // Unguarded, the second update would drop from 90% to 87%.
    expect(
      documentProgressPercent({
        status: "generating",
        index: 1,
        total: 1,
        batch: { done: 4, total: 6 },
      }),
    ).toBe(87);
    expect(seen).toEqual([90, 90, 93, 100]);
  });

  it("keeps separate high-water marks per tracker", () => {
    const a = monotonicPercent();
    const b = monotonicPercent();
    expect(a(40)).toBe(40);
    expect(b(10)).toBe(10);
    expect(a(20)).toBe(40);
  });
});
