/** #2241 — calibrating chat's relevance floor on the Phase 0 question set. */
import { describe, expect, it } from "vitest";
import {
  formatFloorSweep,
  OFF_TOPIC_PROBES,
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
