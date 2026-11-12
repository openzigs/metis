/**
 * #2241 — calibrate chat's relevance floor on the Phase 0 question set.
 *
 * `pnpm eval:ba-qa --floor-sweep` runs chat's knowledge search for every
 * question, once per product in its scope, and records each retrieved chunk's
 * dense cosine and whether it is one of the question's expected sources. No
 * model is called. {@link sweepFloors} then reads, for each candidate floor,
 * what that floor would have done:
 *
 *   - an unanswerable question is caught when no product keeps any excerpt;
 *   - an answerable question is wrongly emptied the same way;
 *   - an expected-source excerpt is lost when the floor drops it;
 *   - an off-topic probe ({@link OFF_TOPIC_PROBES}, a question about nothing
 *     either product holds) is caught when no product keeps any excerpt.
 *
 * The floor is the highest one that empties no answerable question and loses
 * no expected-source excerpt: a floor that hides the evidence for a question
 * the sources do answer turns a right answer into a false abstention.
 */
import { applyRelevanceFloor } from "../../ai/relevance-floor.js";
import type { RetrievalMatcher } from "@metis/shared";
import type { Behaviour } from "./fixture.js";

/**
 * Questions about nothing a software product's sources hold: what the floor is
 * for. Each is searched over every product, as a single-product chat would.
 */
export const OFF_TOPIC_PROBES: readonly string[] = [
  "What is the capital of France?",
  "Write me a poem about autumn leaves.",
  "Who won the 2022 football world cup?",
  "What is our vacation policy for employees?",
  "How do I bake sourdough bread?",
  "What is the quarterly revenue target for the sales team?",
];

/** One retrieved chunk, as the floor reads it. */
export interface SampledHit {
  /** The path or filename the chunk belongs to. */
  name: string;
  /** Its dense cosine; `null` when only the keyword search found it. */
  cosine: number | null;
  /** Whether `name` is one of the question's expected sources. */
  expected: boolean;
}

/** One question's search over one product in its scope. */
export interface RetrievalSample {
  questionId: string;
  /** `off-topic` for an {@link OFF_TOPIC_PROBES} probe. */
  expect: Behaviour | "off-topic";
  product: string;
  hits: SampledHit[];
}

export interface FloorRow {
  floor: number;
  /** Unanswerable questions every product's search emptied, of all unanswerable. */
  unanswerableEmptied: number;
  unanswerable: number;
  /** Answerable questions every product's search emptied, of all answerable. */
  answerableEmptied: number;
  answerable: number;
  /** Ambiguous questions every product's search emptied, of all ambiguous. */
  ambiguousEmptied: number;
  ambiguous: number;
  /** Off-topic probes the floor emptied, over each product searched. */
  offTopicEmptied: number;
  offTopic: number;
  /** Expected-source excerpts the floor kept, of those retrieved without it. */
  expectedKept: number;
  expectedRetrieved: number;
  /** Retrieved excerpts the floor dropped, over every search. */
  dropped: number;
  retrieved: number;
}

function asHits(
  s: RetrievalSample,
): Array<SampledHit & { score: number; matchedBy: RetrievalMatcher[] }> {
  return s.hits.map((h) => ({
    ...h,
    score: h.cosine ?? 0,
    matchedBy: h.cosine === null ? ["lexical"] : ["dense"],
  }));
}

/** What each candidate floor does to the sampled searches. */
export function sweepFloors(
  samples: readonly RetrievalSample[],
  floors: readonly number[],
): FloorRow[] {
  const byQuestion = new Map<string, RetrievalSample[]>();
  for (const s of samples)
    byQuestion.set(s.questionId, [...(byQuestion.get(s.questionId) ?? []), s]);
  return floors.map((floor) => {
    const row: FloorRow = {
      floor,
      unanswerableEmptied: 0,
      unanswerable: 0,
      answerableEmptied: 0,
      answerable: 0,
      ambiguousEmptied: 0,
      ambiguous: 0,
      offTopicEmptied: 0,
      offTopic: 0,
      expectedKept: 0,
      expectedRetrieved: 0,
      dropped: 0,
      retrieved: 0,
    };
    for (const group of byQuestion.values()) {
      if (group[0]!.expect === "off-topic") {
        // A probe stands for a single-product chat: each product counts alone.
        for (const s of group) {
          row.offTopic++;
          if (applyRelevanceFloor(asHits(s), floor).kept.length === 0) row.offTopicEmptied++;
        }
        continue;
      }
      let keptAny = false;
      for (const s of group) {
        const { kept, belowFloor } = applyRelevanceFloor(asHits(s), floor);
        if (kept.length > 0) keptAny = true;
        row.retrieved += s.hits.length;
        row.dropped += belowFloor;
        row.expectedRetrieved += s.hits.filter((h) => h.expected).length;
        row.expectedKept += kept.filter((h) => h.expected).length;
      }
      const emptied = !keptAny;
      const expect = group[0]!.expect;
      if (expect === "abstain") {
        row.unanswerable++;
        if (emptied) row.unanswerableEmptied++;
      } else if (expect === "follow-up") {
        row.ambiguous++;
        if (emptied) row.ambiguousEmptied++;
      } else {
        row.answerable++;
        if (emptied) row.answerableEmptied++;
      }
    }
    return row;
  });
}

/**
 * The highest floor that empties no answerable question and keeps every
 * expected-source excerpt; `null` when no candidate does (not even the lowest).
 */
export function safestFloor(rows: readonly FloorRow[]): number | null {
  const safe = rows.filter(
    (r) => r.answerableEmptied === 0 && r.expectedKept === r.expectedRetrieved,
  );
  return safe.length === 0 ? null : Math.max(...safe.map((r) => r.floor));
}

/** The sweep as a Markdown table. */
export function formatFloorSweep(rows: readonly FloorRow[]): string {
  const lines = [
    "| Floor | Off-topic emptied | Unanswerable emptied | Answerable emptied | Ambiguous emptied | Expected excerpts kept | Excerpts dropped |",
    "|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.floor.toFixed(3)} | ${r.offTopicEmptied}/${r.offTopic} | ${r.unanswerableEmptied}/${r.unanswerable} | ` +
        `${r.answerableEmptied}/${r.answerable} | ${r.ambiguousEmptied}/${r.ambiguous} | ` +
        `${r.expectedKept}/${r.expectedRetrieved} | ${r.dropped}/${r.retrieved} |`,
    );
  }
  return lines.join("\n");
}
