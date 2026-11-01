/**
 * #1623 — the severity derivation: every coupling strength (and the unclassified
 * edge) under every combination of the two modifiers.
 */
import { describe, expect, it } from "vitest";
import type { ChangeSeverity, ProductCouplingStrength } from "@metis/shared";
import {
  deriveHopSeverity,
  moreSevere,
  pathSeverity,
  stepSeverity,
  weaker,
} from "./impact-severity.js";

type Row = [
  strength: ProductCouplingStrength | null,
  breaking: boolean,
  lowConfidence: boolean,
  expected: ChangeSeverity,
];

// strength      breaking  low conf  severity
const TABLE: Row[] = [
  ["intrusive", false, false, "high"],
  ["intrusive", true, false, "high"], // a shared-table write is not counted twice
  ["intrusive", false, true, "medium"],
  ["intrusive", true, true, "medium"],
  ["functional", false, false, "high"],
  ["functional", true, false, "critical"],
  ["functional", false, true, "medium"],
  ["functional", true, true, "high"],
  ["model", false, false, "medium"],
  ["model", true, false, "high"],
  ["model", false, true, "low"],
  ["model", true, true, "medium"],
  ["contract", false, false, "low"],
  ["contract", true, false, "medium"],
  ["contract", false, true, "low"], // capped at low
  ["contract", true, true, "low"],
  [null, false, false, "medium"],
  [null, true, false, "high"],
  [null, false, true, "low"],
  [null, true, true, "medium"],
];

describe("deriveHopSeverity", () => {
  it.each(TABLE)(
    "%s, breaking=%s, low confidence=%s -> %s",
    (strength, breaking, low, expected) => {
      const confidence = low ? 0.3 : 0.9;
      const hop = deriveHopSeverity({ strength, breakingContract: breaking, confidence });
      expect(hop.severity).toBe(expected);
      expect(hop.strength).toBe(strength);
      // The derivation names each modifier that applied, and only those.
      expect(hop.modifiers.map((m) => m.kind)).toEqual([
        ...(breaking && strength !== "intrusive" ? ["breaking-contract"] : []),
        ...(low ? ["low-confidence"] : []),
      ]);
    },
  );

  it("records the base each strength starts from", () => {
    const base = (strength: ProductCouplingStrength | null) =>
      deriveHopSeverity({ strength, breakingContract: false, confidence: 1 }).base;
    expect([
      base("intrusive"),
      base("functional"),
      base("model"),
      base("contract"),
      base(null),
    ]).toEqual(["high", "high", "medium", "low", "medium"]);
  });

  it("0.5 is not low confidence; just under it is", () => {
    const at = (confidence: number) =>
      deriveHopSeverity({ strength: "model", breakingContract: false, confidence }).severity;
    expect(at(0.5)).toBe("medium");
    expect(at(0.49)).toBe("low");
  });

  it("records the confidence that lowered it", () => {
    const hop = deriveHopSeverity({ strength: "model", breakingContract: false, confidence: 0.2 });
    expect(hop.modifiers).toEqual([{ kind: "low-confidence", step: -1, confidence: 0.2 }]);
  });
});

describe("stepSeverity and ordering", () => {
  it("steps towards critical and low, capped at both", () => {
    expect(stepSeverity("high", 1)).toBe("critical");
    expect(stepSeverity("critical", 1)).toBe("critical");
    expect(stepSeverity("medium", -1)).toBe("low");
    expect(stepSeverity("low", -1)).toBe("low");
    expect(stepSeverity("low", 0)).toBe("low");
  });

  it("orders critical > high > medium > low", () => {
    expect(moreSevere("critical", "high")).toBe(true);
    expect(moreSevere("low", "medium")).toBe(false);
    expect(moreSevere("medium", "medium")).toBe(false);
    expect(weaker("high", "low")).toBe("low");
    expect(weaker("low", "high")).toBe("low");
  });
});

describe("pathSeverity", () => {
  it("is the weakest hop of the path", () => {
    expect(pathSeverity([{ severity: "high" }, { severity: "medium" }])).toBe("medium");
    expect(pathSeverity([{ severity: "low" }, { severity: "critical" }])).toBe("low");
    expect(pathSeverity([{ severity: "high" }])).toBe("high");
  });

  it("is null for a direct change (no hops)", () => {
    expect(pathSeverity([])).toBeNull();
  });
});
