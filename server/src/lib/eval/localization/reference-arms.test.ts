import { describe, expect, it } from "vitest";
import { assertReferenceArms, assertReferenceArmsInEachCorpus } from "./reference-arms.js";

describe("assertReferenceArms (#1819)", () => {
  it("accepts references among the run's arms", () => {
    expect(() => assertReferenceArms([], ["A0"])).not.toThrow();
    expect(() => assertReferenceArms(["A12", "A13"], ["A0", "A12", "A13"])).not.toThrow();
  });

  it("refuses a reference the run does not report, naming the arms", () => {
    expect(() => assertReferenceArms(["A12", "A31"], ["A0", "A12", "A13"])).toThrow(
      "--reference A31 is not one of this run's arms (A0, A12, A13)",
    );
    expect(() => assertReferenceArms(["A0"], ["A0", "A12"])).toThrow(/--reference A0/);
  });
});

describe("assertReferenceArmsInEachCorpus (#1925)", () => {
  it("refuses a reference one corpus did not record, though the union of arms holds it", () => {
    const recorded = new Map([
      ["localization-01-miniflux-heldout", ["A0", "A7", "A7S"]],
      ["localization-02-fixture-portfolio", ["A0", "A7"]],
    ]);
    expect(() => assertReferenceArmsInEachCorpus(["A7"], recorded)).not.toThrow();
    expect(() => assertReferenceArmsInEachCorpus(["A7", "A7S"], recorded)).toThrow(
      "--reference A7S is not one of the arms localization-02-fixture-portfolio recorded (A0, A7)",
    );
    expect(() => assertReferenceArmsInEachCorpus(["A0"], recorded)).toThrow(/--reference A0/);
    expect(() => assertReferenceArmsInEachCorpus([], new Map())).not.toThrow();
  });
});
