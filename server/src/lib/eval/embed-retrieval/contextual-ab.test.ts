/**
 * Epic #1068 / Issue #1072 — unit tests for the contextual-document A/B.
 *
 * No weights, no network, no store.
 */
import { describe, it, expect } from "vitest";
import {
  CONTEXTUAL_ARMS,
  decideContextualShip,
  incrementKey,
  isEstablishedGain,
  MIN_IMPORTANT_CONTEXTUAL_BM25_DELTA,
  MIN_IMPORTANT_CONTEXTUAL_FUSED_DELTA,
  SHIPPABLE_ARMS_CHEAPEST_FIRST,
  type DecisionInput,
  type ShipDecisionInput,
} from "./contextual-ab.js";

const gain: DecisionInput = { verdict: "DIRECTION-ESTABLISHED-MAGNITUDE-NOT", meanDelta: 0.03 };
const ship: DecisionInput = { verdict: "SHIP", meanDelta: 0.06 };
const flat: DecisionInput = { verdict: "NOT-ESTABLISHED", meanDelta: 0.01 };
const loss: DecisionInput = { verdict: "DIRECTION-ESTABLISHED-MAGNITUDE-NOT", meanDelta: -0.03 };

function input(
  vsBaseline: Partial<ShipDecisionInput["vsBaseline"]>,
  increments: Record<string, DecisionInput> = {},
): ShipDecisionInput {
  return {
    vsBaseline: { "own-file": flat, "lexical-cross": flat, contextual: flat, ...vsBaseline },
    increments: {
      [incrementKey("lexical-cross", "own-file")]: flat,
      [incrementKey("contextual", "own-file")]: flat,
      [incrementKey("contextual", "lexical-cross")]: flat,
      ...increments,
    },
  };
}

describe("the pre-registered bars (#1072)", () => {
  it("reuses #1159's bars unchanged", () => {
    expect(MIN_IMPORTANT_CONTEXTUAL_FUSED_DELTA).toBe(0.02);
    expect(MIN_IMPORTANT_CONTEXTUAL_BM25_DELTA).toBe(0.05);
  });

  it("names baseline first and the primary treatment as full/full", () => {
    expect(CONTEXTUAL_ARMS[0]).toMatchObject({
      id: "baseline",
      lexical: "base",
      embedding: "base",
    });
    expect(CONTEXTUAL_ARMS.find((a) => a.id === "contextual")).toMatchObject({
      lexical: "full",
      embedding: "full",
    });
    expect(CONTEXTUAL_ARMS.find((a) => a.id === "lexical-cross")).toMatchObject({
      lexical: "full",
      embedding: "own",
    });
    expect(CONTEXTUAL_ARMS.find((a) => a.id === "own-file")).toMatchObject({
      lexical: "own",
      embedding: "own",
    });
    expect(CONTEXTUAL_ARMS.find((a) => a.id === "lexical-only")).toMatchObject({
      lexical: "full",
      embedding: "base",
    });
    expect(CONTEXTUAL_ARMS.find((a) => a.id === "vector-only")).toMatchObject({
      lexical: "base",
      embedding: "full",
    });
    expect(new Set(CONTEXTUAL_ARMS.map((a) => a.id)).size).toBe(CONTEXTUAL_ARMS.length);
  });

  it("orders the shippable arms cheapest first, the primary last", () => {
    expect(SHIPPABLE_ARMS_CHEAPEST_FIRST).toEqual(["own-file", "lexical-cross", "contextual"]);
  });
});

describe("isEstablishedGain", () => {
  it("accepts SHIP and direction-established when the delta is positive", () => {
    expect(isEstablishedGain(ship)).toBe(true);
    expect(isEstablishedGain(gain)).toBe(true);
  });

  it("rejects NOT-ESTABLISHED even with a positive point estimate", () => {
    expect(isEstablishedGain(flat)).toBe(false);
  });

  it("rejects an established LOSS, which classifyDelta files under direction-established", () => {
    expect(isEstablishedGain(loss)).toBe(false);
  });

  it("rejects a zero delta", () => {
    expect(isEstablishedGain({ verdict: "SHIP", meanDelta: 0 })).toBe(false);
  });
});

describe("decideContextualShip — the pre-registered rule", () => {
  it("ships nothing when the primary treatment is not established", () => {
    const d = decideContextualShip(input({ contextual: flat }));
    expect(d.ship).toBe("none");
    expect(d.reasons[0]).toContain("the gate is closed");
    expect(d.reasons).toHaveLength(1);
  });

  it("ships nothing when only a CHEAPER arm is an established gain", () => {
    const d = decideContextualShip(input({ "own-file": ship, "lexical-cross": ship }));
    expect(d.ship).toBe("none");
  });

  it("ships nothing when the primary treatment is an established loss", () => {
    expect(decideContextualShip(input({ contextual: loss })).ship).toBe("none");
  });

  it("ships the primary when no cheaper arm is itself an established gain", () => {
    const d = decideContextualShip(input({ contextual: gain }));
    expect(d.ship).toBe("contextual");
    expect(d.reasons[0]).toContain("the gate is open");
    expect(d.reasons.some((r) => r.startsWith("own-file vs baseline is NOT-ESTABLISHED"))).toBe(
      true,
    );
  });

  it("ships the cheapest arm that is a gain and is not established worse than a costlier one", () => {
    const d = decideContextualShip(
      input({ contextual: gain, "lexical-cross": gain, "own-file": gain }),
    );
    expect(d.ship).toBe("own-file");
  });

  it("skips a cheaper arm that a costlier one beats as an established gain", () => {
    const d = decideContextualShip(
      input(
        { contextual: gain, "lexical-cross": gain, "own-file": gain },
        { [incrementKey("lexical-cross", "own-file")]: gain },
      ),
    );
    expect(d.ship).toBe("lexical-cross");
    expect(d.reasons).toContain(
      "own-file is an established gain, but lexical-cross is established better.",
    );
  });

  it("skips to the primary when it beats both cheaper arms", () => {
    const d = decideContextualShip(
      input(
        { contextual: ship, "lexical-cross": gain, "own-file": gain },
        {
          [incrementKey("contextual", "own-file")]: gain,
          [incrementKey("contextual", "lexical-cross")]: gain,
        },
      ),
    );
    expect(d.ship).toBe("contextual");
  });

  it("does not let an established LOSS of the costlier arm count as beating the cheaper", () => {
    const d = decideContextualShip(
      input(
        { contextual: gain, "own-file": gain },
        { [incrementKey("contextual", "own-file")]: loss },
      ),
    );
    expect(d.ship).toBe("own-file");
  });

  it("treats a missing increment as not established", () => {
    const d = decideContextualShip({
      vsBaseline: { "own-file": gain, "lexical-cross": flat, contextual: gain },
      increments: {},
    });
    expect(d.ship).toBe("own-file");
  });

  it("takes lexical-cross when own-file is not a gain on its own", () => {
    const d = decideContextualShip(input({ contextual: gain, "lexical-cross": gain }));
    expect(d.ship).toBe("lexical-cross");
  });
});
