import { describe, expect, it } from "vitest";
import { sectionProgressMessage, sectionProgressPercent } from "./section-progress.js";

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
