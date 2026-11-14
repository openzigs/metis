/** #2241 — calibrating chat's relevance floor on the Phase 0 question set. */
import { describe, expect, it } from "vitest";
import {
  floorCandidates,
  floorMargin,
  floorQuestionsFromBaQa,
  floorQuestionsFromLocalization,
  formatFloorSweep,
  OFF_TOPIC_PROBES,
  parseFloorCorpus,
  safestFloor,
  sweepFloors,
  type RetrievalSample,
} from "./relevance-floor.js";

const hit = (cosine: number | null, expected = false) => ({ name: "f", cosine, expected });

const samples: RetrievalSample[] = [
  // An answerable question over two products: its evidence is at 0.6 and 0.7.
  { questionId: "S1", expect: "answer", product: "a", hits: [hit(0.7, true), hit(0.5)] },
  { questionId: "S1", expect: "answer", product: "b", hits: [hit(0.6, true), hit(null)] },
  // An unanswerable one whose best match is 0.65.
  { questionId: "U1", expect: "abstain", product: "a", hits: [hit(0.65), hit(0.52)] },
  { questionId: "A1", expect: "follow-up", product: "a", hits: [hit(0.58)] },
  // Two off-topic probes, each product counted alone.
  { questionId: "P1", expect: "off-topic", product: "a", hits: [hit(0.5)] },
  { questionId: "P1", expect: "off-topic", product: "b", hits: [hit(0.62)] },
];

describe("sweepFloors", () => {
  it("counts what each floor empties and drops", () => {
    const [low, mid, high] = sweepFloors(samples, [0.4, 0.6, 0.7]);
    expect(low).toMatchObject({
      floor: 0.4,
      unanswerableEmptied: 0,
      answerableEmptied: 0,
      ambiguousEmptied: 0,
      offTopicEmptied: 0,
      offTopic: 2,
      expectedKept: 2,
      expectedRetrieved: 2,
      dropped: 0,
      retrieved: 7,
    });
    // At 0.6: the 0.5, 0.52 and 0.58 matches go, and the keyword-only hit stays
    // beside product b's 0.6; one probe and the ambiguous question are emptied.
    expect(mid).toMatchObject({
      unanswerableEmptied: 0,
      answerableEmptied: 0,
      ambiguousEmptied: 1,
      offTopicEmptied: 1,
      expectedKept: 2,
      dropped: 3,
    });
    // At 0.7 product b loses its evidence (and its keyword hit); product a keeps it.
    expect(high).toMatchObject({
      unanswerableEmptied: 1,
      unanswerable: 1,
      answerableEmptied: 0,
      answerable: 1,
      offTopicEmptied: 2,
      expectedKept: 1,
    });
  });

  it("counts a question emptied only when every product in its scope is", () => {
    const [row] = sweepFloors(samples, [0.75]);
    expect(row.answerableEmptied).toBe(1);
  });
});

describe("safestFloor", () => {
  it("is the highest floor that empties no answerable question and keeps all evidence", () => {
    expect(safestFloor(sweepFloors(samples, [0.4, 0.6, 0.65, 0.7]))).toBe(0.6);
  });

  it("is null when no floor is safe", () => {
    expect(safestFloor(sweepFloors(samples, [0.75, 0.8]))).toBeNull();
  });
});

describe("formatFloorSweep", () => {
  it("renders one row per floor", () => {
    const md = formatFloorSweep(sweepFloors(samples, [0.6]));
    expect(md).toContain("| Floor | Off-topic emptied |");
    expect(md).toContain("| 0.600 | 1/2 | 0/1 | 0/1 | 1/1 | 2/2 | 3/7 |");
  });
});

describe("OFF_TOPIC_PROBES", () => {
  it("are distinct questions", () => {
    expect(new Set(OFF_TOPIC_PROBES).size).toBe(OFF_TOPIC_PROBES.length);
    expect(OFF_TOPIC_PROBES.length).toBeGreaterThanOrEqual(6);
  });
});

describe("floorQuestionsFromBaQa (#2417)", () => {
  it("searches each product in scope, expecting only that product's sources", () => {
    const [q] = floorQuestionsFromBaQa([
      {
        id: "M1",
        text: "How do the two products authenticate?",
        expect: "answer",
        scope: ["server", "client"],
        sources: [
          { product: "server", path: "auth.go" },
          { product: "client", path: "client.py" },
          { product: "server", path: "keys.go" },
        ],
      },
    ]);
    expect(q).toMatchObject({ id: "M1", expect: "answer" });
    expect(q!.scope.map((s) => [s.product, [...s.expected]])).toEqual([
      ["server", ["auth.go", "keys.go"]],
      ["client", ["client.py"]],
    ]);
  });

  it("expects nothing of a question with no sources", () => {
    const [q] = floorQuestionsFromBaQa([
      { id: "U1", text: "?", expect: "abstain", scope: ["server"] },
    ]);
    expect([...q!.scope[0]!.expected]).toEqual([]);
  });
});

describe("floorQuestionsFromLocalization (#2417)", () => {
  it("asks each item, with its title, in each repository holding an expected file", () => {
    const [q] = floorQuestionsFromLocalization([
      {
        id: "FX-09",
        title: "Refund an invoice",
        text: "Customers can ask for a refund.",
        expectedFiles: ["billing:src/a.ts", "orders:./src/b.ts", "billing:src/c.ts"],
      },
    ]);
    expect(q).toMatchObject({
      id: "FX-09",
      expect: "answer",
      text: "Refund an invoice\n\nCustomers can ask for a refund.",
    });
    expect(q!.scope.map((s) => [s.product, [...s.expected]])).toEqual([
      ["billing", ["src/a.ts", "src/c.ts"]],
      ["orders", ["src/b.ts"]],
    ]);
  });
});

describe("floorMargin (#2417)", () => {
  it("names the lowest expected excerpt and the highest off-topic one", () => {
    const m = floorMargin(samples);
    expect(m.lowestExpected).toEqual({ questionId: "S1", product: "b", name: "f", cosine: 0.6 });
    expect(m.highestOffTopic).toEqual({
      questionId: "P1",
      product: "b",
      name: "f",
      cosine: 0.62,
    });
  });

  it("ignores keyword-only hits, and is null where nothing was retrieved", () => {
    const m = floorMargin([
      { questionId: "S1", expect: "answer", product: "a", hits: [hit(null, true), hit(0.9)] },
      { questionId: "P1", expect: "off-topic", product: "a", hits: [hit(null)] },
    ]);
    expect(m).toEqual({ lowestExpected: null, highestOffTopic: null });
  });
});

describe("floorCandidates (#2417)", () => {
  it("covers every retrieved cosine, on 0.05 bounds, a step of 0.01 apart", () => {
    const floors = floorCandidates(samples);
    // The cosines run from 0.5 to 0.7.
    expect(floors[0]).toBe(0.5);
    expect(floors.at(-1)).toBe(0.7);
    expect(floors).toHaveLength(21);
    expect(floors).toContain(0.58);
  });

  it("follows another embedder's scale", () => {
    const floors = floorCandidates([
      { questionId: "S1", expect: "answer", product: "a", hits: [hit(0.31), hit(0.88)] },
    ]);
    expect([floors[0], floors.at(-1)]).toEqual([0.3, 0.9]);
  });

  it("is empty when no hit has a cosine", () => {
    expect(floorCandidates([])).toEqual([]);
    expect(
      floorCandidates([{ questionId: "S1", expect: "answer", product: "a", hits: [hit(null)] }]),
    ).toEqual([]);
  });
});

describe("parseFloorCorpus (#2417)", () => {
  const sweep = { floorSweep: true, routingSweep: false };

  it("is null when not given", () => {
    expect(parseFloorCorpus(undefined, sweep)).toBeNull();
  });

  it("takes a localization corpus", () => {
    expect(parseFloorCorpus("localization-02-fixture-portfolio", sweep)).toBe(
      "localization-02-fixture-portfolio",
    );
  });

  it("refuses an unknown corpus", () => {
    expect(() => parseFloorCorpus("baqa-01-acme-reader", sweep)).toThrow(/must be one of/);
  });

  it("needs --floor-sweep, and not --routing-sweep", () => {
    const corpus = "localization-02-fixture-portfolio";
    expect(() => parseFloorCorpus(corpus, { floorSweep: false, routingSweep: false })).toThrow(
      /needs --floor-sweep/,
    );
    expect(() => parseFloorCorpus(corpus, { floorSweep: true, routingSweep: true })).toThrow(
      /not --routing-sweep/,
    );
  });
});
