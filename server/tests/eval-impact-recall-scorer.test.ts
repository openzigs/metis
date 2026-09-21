/**
 * Epic #929 / Issue #930 — pure scorer math for the Impact Analysis recall eval.
 * Asserts the recall/precision set algebra, the HIT/WRONG/MISS breakdown, the
 * empty-set conventions, normalization, and macro/micro aggregation.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateScores,
  normalizeCodeSymbol,
  normalizeConsumer,
  normalizeTable,
  scoreRequirement,
  scoreSet,
} from "../src/lib/eval/impact-recall/scorer.js";

describe("normalizeTable", () => {
  it("strips an optional schema prefix and lowercases", () => {
    expect(normalizeTable("Sales.ORDERS")).toBe("orders");
    expect(normalizeTable("product")).toBe("product");
    expect(normalizeTable("  Account ")).toBe("account");
  });
});

describe("normalizeCodeSymbol", () => {
  it("takes the simple (last dotted) segment, lowercased", () => {
    expect(normalizeCodeSymbol("org.jpetstore.persistence.ProductMapper.updateProduct")).toBe(
      "updateproduct",
    );
    expect(normalizeCodeSymbol("getOrder")).toBe("getorder");
  });
});

describe("scoreSet", () => {
  it("computes recall, precision, and the HIT/WRONG/MISS breakdown", () => {
    const s = scoreSet(["orders", "account"], ["orders", "lineitem"], normalizeTable);
    expect(s.hit).toEqual(["orders"]);
    expect(s.wrong).toEqual(["account"]);
    expect(s.miss).toEqual(["lineitem"]);
    expect(s.recall).toBeCloseTo(0.5); // 1 of 2 expected found
    expect(s.precision).toBeCloseTo(0.5); // 1 of 2 found correct
  });

  it("is perfect when found == expected", () => {
    const s = scoreSet(["a", "b"], ["b", "a"], normalizeTable);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.wrong).toEqual([]);
    expect(s.miss).toEqual([]);
  });

  it("normalizes both sides before the set algebra", () => {
    const s = scoreSet(["Sales.Orders"], ["orders"], normalizeTable);
    expect(s.hit).toEqual(["orders"]);
    expect(s.precision).toBe(1);
  });

  it("dedupes and sorts", () => {
    const s = scoreSet(["b", "a", "a"], ["a", "b", "b"], normalizeTable);
    expect(s.found).toEqual(["a", "b"]);
    expect(s.expected).toEqual(["a", "b"]);
  });

  it("empty expected ⇒ recall 1 (nothing to find)", () => {
    const s = scoreSet(["x"], [], normalizeTable);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(0); // 0 of 1 found is expected
    expect(s.wrong).toEqual(["x"]);
  });

  it("empty found ⇒ precision 1 (nothing wrong surfaced), recall 0 on a MISS", () => {
    const s = scoreSet([], ["y"], normalizeTable);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(0);
    expect(s.miss).toEqual(["y"]);
  });
});

describe("scoreRequirement", () => {
  it("scores tables always and code only when labeled", () => {
    const withCode = scoreRequirement({
      id: "R1",
      text: "t",
      expectedTables: ["orders"],
      foundTables: ["orders"],
      expectedCodeSymbols: ["insertOrder"],
      foundCodeSymbols: ["OrderMapper.insertOrder"],
    });
    expect(withCode.tables.recall).toBe(1);
    expect(withCode.code?.recall).toBe(1);

    const noCode = scoreRequirement({
      id: "R2",
      text: "t",
      expectedTables: ["orders"],
      foundTables: ["orders"],
      foundCodeSymbols: ["whatever"],
    });
    expect(noCode.code).toBeNull();
  });
});

describe("normalizeConsumer (#959)", () => {
  it("trims and lowercases the whole project id (no dotted-segment stripping)", () => {
    expect(normalizeConsumer("  Impact-Recall-02-Reporting ")).toBe("impact-recall-02-reporting");
    // Unlike tables/symbols, a dotted id is compared WHOLE.
    expect(normalizeConsumer("acme.reporting")).toBe("acme.reporting");
  });
});

describe("scoreRequirement — consumer dimension (#959)", () => {
  it("is null when the requirement omits the expectedConsumers key (single-project)", () => {
    const s = scoreRequirement({
      id: "R1",
      text: "t",
      expectedTables: ["account"],
      foundTables: ["account"],
      foundCodeSymbols: [],
    });
    expect(s.consumers).toBeNull();
  });

  it("scores consumers when the key is PRESENT but empty (a true-negative)", () => {
    const s = scoreRequirement({
      id: "R1",
      text: "t",
      expectedTables: ["cart"],
      foundTables: ["cart"],
      foundCodeSymbols: [],
      expectedConsumers: [], // declared: asserts "no cross-project consumer"
      foundConsumers: [],
    });
    expect(s.consumers).not.toBeNull();
    expect(s.consumers?.recall).toBe(1); // nothing expected ⇒ fully recalled
    expect(s.consumers?.precision).toBe(1); // nothing surfaced ⇒ nothing wrong
  });

  it("records a consumer MISS at the honest pre-wiring baseline (found empty)", () => {
    const s = scoreRequirement({
      id: "R1",
      text: "t",
      expectedTables: ["account"],
      foundTables: ["account"],
      foundCodeSymbols: [],
      expectedConsumers: ["reporting"],
      foundConsumers: [], // engine surfaces no consumers yet
    });
    expect(s.consumers?.recall).toBe(0);
    expect(s.consumers?.precision).toBe(1); // vacuous — empty found
    expect(s.consumers?.miss).toEqual(["reporting"]);
  });

  it("normalizes and scores a resolved consumer set (future #956 path)", () => {
    const s = scoreRequirement({
      id: "R1",
      text: "t",
      expectedTables: ["orders"],
      foundTables: ["orders"],
      foundCodeSymbols: [],
      expectedConsumers: ["Reporting"],
      foundConsumers: ["reporting", "unrelated"],
    });
    expect(s.consumers?.hit).toEqual(["reporting"]);
    expect(s.consumers?.wrong).toEqual(["unrelated"]);
    expect(s.consumers?.recall).toBe(1);
    expect(s.consumers?.precision).toBeCloseTo(0.5);
  });
});

describe("aggregateScores", () => {
  it("computes macro (per-req mean), micro (pooled), and hit rate", () => {
    const scores = [
      scoreRequirement({
        id: "R1",
        text: "t",
        expectedTables: ["a"],
        foundTables: ["a", "b"], // recall 1, precision 0.5
        foundCodeSymbols: [],
      }),
      scoreRequirement({
        id: "R2",
        text: "t",
        expectedTables: ["c", "d"],
        foundTables: ["c"], // recall 0.5, precision 1
        foundCodeSymbols: [],
      }),
    ];
    const agg = aggregateScores(scores);
    expect(agg.requirementCount).toBe(2);
    expect(agg.tables.macroRecall).toBeCloseTo(0.75); // (1 + 0.5) / 2
    expect(agg.tables.macroPrecision).toBeCloseTo(0.75); // (0.5 + 1) / 2
    // micro: TP = 1 (a) + 1 (c) = 2; expected = 1 + 2 = 3; found = 2 + 1 = 3
    expect(agg.tables.microRecall).toBeCloseTo(2 / 3);
    expect(agg.tables.microPrecision).toBeCloseTo(2 / 3);
    expect(agg.tables.hitRate).toBe(1);
    // No code labels anywhere.
    expect(agg.code).toBeNull();
  });

  it("omits the consumers key entirely when NO requirement declares it (#959 byte-identical)", () => {
    const scores = [
      scoreRequirement({
        id: "R1",
        text: "t",
        expectedTables: ["a"],
        foundTables: ["a"],
        foundCodeSymbols: [],
      }),
    ];
    const agg = aggregateScores(scores);
    // The key must be ABSENT (not null) so serialized single-project reports are unchanged.
    expect("consumers" in agg).toBe(false);
  });

  it("aggregates the consumer dimension only over declaring requirements (#959)", () => {
    const scores = [
      scoreRequirement({
        id: "R1",
        text: "t",
        expectedTables: ["account"],
        foundTables: ["account"],
        foundCodeSymbols: [],
        expectedConsumers: ["reporting"],
        foundConsumers: [], // baseline MISS
      }),
      scoreRequirement({
        id: "R2",
        text: "t",
        expectedTables: ["cart"],
        foundTables: ["cart"],
        foundCodeSymbols: [],
        // no consumer label ⇒ excluded from the consumer aggregate
      }),
    ];
    const agg = aggregateScores(scores);
    expect(agg.consumers?.labeledCount).toBe(1);
    expect(agg.consumers?.macroRecall).toBe(0);
    expect(agg.consumers?.macroPrecision).toBe(1);
  });

  it("returns a zeroed dimension for an empty score list", () => {
    const agg = aggregateScores([]);
    expect(agg.requirementCount).toBe(0);
    expect(agg.tables.labeledCount).toBe(0);
    expect(agg.tables.macroRecall).toBe(0);
    expect(agg.tables.hitRate).toBe(0);
  });

  it("aggregates the code dimension only over labeled requirements", () => {
    const scores = [
      scoreRequirement({
        id: "R1",
        text: "t",
        expectedTables: ["a"],
        foundTables: ["a"],
        expectedCodeSymbols: ["foo"],
        foundCodeSymbols: ["foo", "bar"], // code recall 1, precision 0.5
      }),
      scoreRequirement({
        id: "R2",
        text: "t",
        expectedTables: ["b"],
        foundTables: ["b"],
        foundCodeSymbols: ["ignored"], // no code label
      }),
    ];
    const agg = aggregateScores(scores);
    expect(agg.code?.labeledCount).toBe(1);
    expect(agg.code?.macroPrecision).toBeCloseTo(0.5);
  });
});
