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
 *
 * #2417 — `--floor-corpus <localization corpus>` sweeps a second corpus: its
 * items ({@link floorQuestionsFromLocalization}) searched over the
 * repositories that hold their expected files. {@link floorMargin} names the
 * two edges a floor sits between, so repeated runs can be compared.
 */
import { applyRelevanceFloor } from "../../ai/relevance-floor.js";
import type { RetrievalMatcher } from "@metis/shared";
import type { Behaviour, BaQaQuestion } from "./fixture.js";
import {
  LOCALIZATION_CORPORA,
  normalizeFilePath,
  repoOfFileKey,
  type LocalizationCorpusName,
  type LocalizationItem,
} from "../localization/corpus.js";

/**
 * #2417 — `--floor-corpus`: the localization corpus to sweep instead of the BA
 * questions, or `null` when not given. It needs `--floor-sweep`, and is refused
 * beside `--routing-sweep`, which sweeps the routing set.
 */
export function parseFloorCorpus(
  value: string | undefined,
  opts: { floorSweep: boolean; routingSweep: boolean },
): LocalizationCorpusName | null {
  if (value === undefined) return null;
  if (!opts.floorSweep || opts.routingSweep) {
    throw new Error("--floor-corpus needs --floor-sweep, and not --routing-sweep");
  }
  if (!(LOCALIZATION_CORPORA as readonly string[]).includes(value)) {
    throw new Error(`--floor-corpus must be one of ${LOCALIZATION_CORPORA.join(", ")}`);
  }
  return value as LocalizationCorpusName;
}

/** One question as the sweep searches it: once over each product in `scope`. */
export interface FloorQuestion {
  id: string;
  text: string;
  expect: Behaviour;
  /** The products searched, each with the paths that count as its expected sources. */
  scope: ReadonlyArray<{ product: string; expected: ReadonlySet<string> }>;
}

/** The BA question set's questions, each searched over the products in its scope. */
export function floorQuestionsFromBaQa(
  questions: readonly Pick<BaQaQuestion, "id" | "text" | "expect" | "scope" | "sources">[],
): FloorQuestion[] {
  return questions.map((q) => ({
    id: q.id,
    text: q.text,
    expect: q.expect,
    scope: q.scope.map((product) => ({
      product,
      expected: new Set((q.sources ?? []).filter((s) => s.product === product).map((s) => s.path)),
    })),
  }));
}

/**
 * #2417 — a localization corpus's items as answerable questions: the title and
 * text the arms see, asked in each repository that holds one of its expected
 * files (`<repo>:<path>`), as a chat scoped to that repository would ask it.
 */
export function floorQuestionsFromLocalization(
  items: readonly Pick<LocalizationItem, "id" | "title" | "text" | "expectedFiles">[],
): FloorQuestion[] {
  return items.map((item) => {
    const byRepo = new Map<string, Set<string>>();
    for (const key of item.expectedFiles) {
      const repo = repoOfFileKey(key);
      const file = normalizeFilePath(key.slice(repo.length + 1));
      byRepo.set(repo, (byRepo.get(repo) ?? new Set()).add(file));
    }
    return {
      id: item.id,
      text: `${item.title}\n\n${item.text}`,
      expect: "answer" as const,
      scope: [...byRepo].map(([product, expected]) => ({ product, expected })),
    };
  });
}

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

/** One retrieved chunk at an edge of the floor's margin. */
export interface FloorEdge {
  questionId: string;
  product: string;
  name: string;
  cosine: number;
}

/**
 * #2417 — the two edges a floor sits between: the lowest cosine of an
 * expected-source excerpt (a floor above it loses that excerpt) and the
 * highest cosine an off-topic probe retrieved (a floor at or below it leaves
 * that probe some excerpt). `null` when no such chunk was retrieved.
 */
export function floorMargin(samples: readonly RetrievalSample[]): {
  lowestExpected: FloorEdge | null;
  highestOffTopic: FloorEdge | null;
} {
  let lowestExpected: FloorEdge | null = null;
  let highestOffTopic: FloorEdge | null = null;
  for (const s of samples) {
    for (const h of s.hits) {
      if (h.cosine === null) continue;
      const edge = { questionId: s.questionId, product: s.product, name: h.name, cosine: h.cosine };
      if (s.expect === "off-topic") {
        if (!highestOffTopic || h.cosine > highestOffTopic.cosine) highestOffTopic = edge;
      } else if (h.expected && (!lowestExpected || h.cosine < lowestExpected.cosine)) {
        lowestExpected = edge;
      }
    }
  }
  return { lowestExpected, highestOffTopic };
}

/**
 * #2417 — the floors to sweep: every 0.01 from the lowest retrieved cosine
 * (rounded down to 0.05) to the highest (rounded up), so an embedder whose
 * cosines sit on another scale is swept over its own range.
 */
export function floorCandidates(samples: readonly RetrievalSample[]): number[] {
  const cosines = samples.flatMap((s) =>
    s.hits.flatMap((h) => (h.cosine === null ? [] : [h.cosine])),
  );
  if (cosines.length === 0) return [];
  const lo = Math.max(0, Math.floor(Math.min(...cosines) * 20) / 20);
  const hi = Math.min(1, Math.ceil(Math.max(...cosines) * 20) / 20);
  const steps = Math.round((hi - lo) * 100);
  return Array.from({ length: steps + 1 }, (_, i) => Number((lo + i * 0.01).toFixed(2)));
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
