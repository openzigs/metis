/**
 * #1070 — the topic plan of a business-requirements document.
 *
 * Until now a document's length was settled AFTER it was written: each section
 * was cut at its tail to `DOCS_GEN_SECTION_MAX_CHARS`, then the longest
 * sections were cut again until the total fitted `DOCS_GEN_DOCUMENT_MAX_CHARS`
 * (`section-size.ts`). In #706 run 7 the four catalogue sections of the Miniflux
 * BRD each ran to their 60k cap and lost 53 topics to it, and the document cap
 * then took 34 more: 87 topics, every one of them at a section's tail, which is
 * where the parts written from the lowest-ranked modules land — and where any
 * topic lands when an earlier part overran.
 *
 * The plan settles the length BEFORE anything is written, from what is known
 * then — the modules each section will read and the output each is estimated
 * to produce — with no model call:
 *
 *   - the document budget is shared among the sections ({@link planDocument}):
 *     a section asking for less than an equal share keeps what it asks for, and
 *     the rest is divided among the others (max-min), so the sections' budgets
 *     and the unallocated remainder sum to the document budget exactly;
 *   - a catalogue section's budget is shared among its topics — one topic per
 *     module with content for that section, owned by that section alone — in
 *     proportion to their estimates, each with a floor ({@link MIN_TOPIC_CHARS});
 *   - when even the floors do not fit, the LOWEST-PRIORITY topics are dropped,
 *     here, and named in the plan, instead of whichever topics happened to be
 *     written last.
 *
 * After generation {@link fitPartsToBudgets} holds each written part to the
 * budget of the topics it covers, cutting a part that overran at ITS tail (the
 * prompt asks for the most significant rules first) rather than cutting the
 * section's tail. The section and document caps stay as a last-resort guard.
 *
 * Pure: no I/O and no model calls.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";
import { fitSectionToBudget, type Measure } from "./section-size.js";

/** Registry key: `off` restores the pre-#1070 behaviour (post-hoc caps only). */
export const TOPIC_PLAN_KEY = "DOCS_GEN_TOPIC_PLAN";

/**
 * Bumped when the allocation rule changes, so a section written under another
 * rule is not reused (the plan is part of each section's reuse inputs).
 */
export const TOPIC_PLAN_VERSION = 1;

/**
 * The least a planned topic is given: about 25 words, one rule stated as a
 * sentence. A topic that cannot have this much is dropped at planning time
 * rather than asked for in a phrase. On the #706 run-7 inputs (102 modules, a
 * 41k section budget) the floors take 15k and the other 26k is shared in
 * proportion to the estimates, so the largest module is planned about twenty
 * times the smallest.
 */
export const MIN_TOPIC_CHARS = 150;

/**
 * What a section written in ONE call asks of the document budget: about 4,000
 * words. Its prompt asks for 1,500 to 3,000; across the eleven stored BRDs the
 * median Overview, Capabilities and Integrations sections rendered at 15k, 23k
 * and 21k characters.
 */
export const SINGLE_CALL_SECTION_CHARS = 24_000;

/** Whether the topic plan is on (default) for document types that have one. */
export function topicPlanEnabled(config: ConfigService = getConfigService()): boolean {
  const raw = config.get(TOPIC_PLAN_KEY);
  return raw == null || !/^(0|false|no|off)$/i.test(raw.trim());
}

/** A topic before planning. */
export interface TopicCandidate {
  /** Unique in the document; a topic belongs to exactly one section. */
  id: string;
  /** What a reader is shown when the topic is listed. */
  title: string;
  /** Higher is planned first and dropped last. */
  priority: number;
  /** Characters the topic is estimated to need (unbounded). */
  estimatedChars: number;
}

/** What one section asks of the plan. */
export interface SectionDemand {
  sectionId: string;
  label: string;
  /**
   * `enumerative` — a catalogue written in parts, one topic per module.
   * `single` — written in one call: the section is its own single topic.
   */
  kind: "enumerative" | "single";
  /** The section's topics; ignored (one is made) for a `single` section. */
  topics: TopicCandidate[];
}

export interface PlannedTopic extends TopicCandidate {
  sectionId: string;
  budgetChars: number;
}

/** A topic the plan left out, with the section that would have owned it. */
export interface DroppedTopic extends TopicCandidate {
  sectionId: string;
}

export interface PlannedSection {
  sectionId: string;
  label: string;
  kind: "enumerative" | "single";
  /** What the section asked for, after the per-section cap. */
  demandChars: number;
  /** What it was given: the sum of its topics' budgets. */
  budgetChars: number;
  /** Planned topics, highest priority first. */
  topics: PlannedTopic[];
  /** Topics left out at planning time, highest priority first. */
  dropped: DroppedTopic[];
}

export interface DocumentPlan {
  version: typeof TOPIC_PLAN_VERSION;
  /** `DOCS_GEN_DOCUMENT_MAX_CHARS` less the room kept for footnote definitions. */
  budgetChars: number;
  sections: PlannedSection[];
  /** Budget no section asked for. `budgetChars` = the sections' budgets + this. */
  unallocatedChars: number;
}

/** Highest priority first; ties by id, so the order never depends on input order. */
function byPriority<T extends TopicCandidate>(topics: readonly T[]): T[] {
  return [...topics].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

/**
 * Share `total` among `asks` max-min: every ask at or below the common level is
 * met in full and the others get the level. Integer shares; the total is never
 * exceeded.
 */
export function waterFill(asks: readonly number[], total: number): number[] {
  const order = asks.map((ask, i) => ({ ask: Math.max(0, Math.floor(ask)), i }));
  order.sort((a, b) => a.ask - b.ask || a.i - b.i);
  const out = asks.map(() => 0);
  let remaining = Math.max(0, Math.floor(total));
  for (let k = 0; k < order.length; k++) {
    const share = Math.floor(remaining / (order.length - k));
    const given = Math.min(order[k].ask, share);
    out[order[k].i] = given;
    remaining -= given;
  }
  return out;
}

/**
 * Share a section's `budget` among its topics. Every kept topic gets its floor
 * (its estimate when that is smaller); what is left is divided in proportion to
 * what each topic still needs, and no topic gets more than its estimate. When
 * the floors alone exceed the budget, the lowest-priority topics are dropped
 * until they fit. The kept budgets sum to at most `budget`, and to exactly
 * `budget` whenever the kept topics' estimates reach it.
 */
export function allocateTopicBudgets(
  topics: readonly TopicCandidate[],
  budget: number,
): { kept: Array<TopicCandidate & { budgetChars: number }>; dropped: TopicCandidate[] } {
  const ranked = byPriority(topics);
  const need = (t: TopicCandidate): number => Math.max(1, Math.floor(t.estimatedChars));
  const floorOf = (t: TopicCandidate): number => Math.min(need(t), MIN_TOPIC_CHARS);
  const room = Math.max(0, Math.floor(budget));
  let keptCount = ranked.length;
  let floors = ranked.reduce((n, t) => n + floorOf(t), 0);
  while (keptCount > 0 && floors > room) {
    keptCount -= 1;
    floors -= floorOf(ranked[keptCount]);
  }
  const kept = ranked.slice(0, keptCount);
  const dropped = ranked.slice(keptCount);
  const spare = room - floors;
  const wants = kept.map((t) => need(t) - floorOf(t));
  const wanted = wants.reduce((n, w) => n + w, 0);
  const extra =
    wanted <= spare
      ? wants
      : // Largest remainders, so the shares are whole and sum to `spare`.
        largestRemainder(wants, spare);
  return {
    kept: kept.map((t, i) => ({ ...t, budgetChars: floorOf(t) + extra[i] })),
    dropped,
  };
}

/** `total` divided in proportion to `weights`, in whole units that sum to it. */
function largestRemainder(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((n, w) => n + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((n, x) => n + x, 0);
  const order = exact
    .map((x, i) => ({ frac: x - Math.floor(x), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && left > 0; k++, left--) out[order[k].i] += 1;
  return out;
}

/**
 * Plan a document: share `documentMaxChars - reservedChars` among the sections,
 * then each section's share among its topics.
 *
 * A topic id that a second section also submits stays with the first (a topic
 * has one owner); the caller derives ids from the owning section, so this only
 * guards against a mistake there.
 */
export function planDocument(input: {
  sections: readonly SectionDemand[];
  documentMaxChars: number;
  sectionMaxChars: number;
  /** Room set aside before planning (the footnote definitions). */
  reservedChars?: number;
}): DocumentPlan {
  const budgetChars = Math.max(
    0,
    Math.floor(input.documentMaxChars) - Math.max(0, Math.floor(input.reservedChars ?? 0)),
  );
  const cap = Math.max(0, Math.floor(input.sectionMaxChars));
  const owned = new Set<string>();
  const demands = input.sections.map((section) => {
    const topics: TopicCandidate[] =
      section.kind === "single"
        ? [
            {
              id: section.sectionId,
              title: section.label,
              priority: 0,
              estimatedChars: SINGLE_CALL_SECTION_CHARS,
            },
          ]
        : section.topics.filter((t) => !owned.has(t.id));
    for (const t of topics) owned.add(t.id);
    const asked = topics.reduce((n, t) => n + Math.max(1, Math.floor(t.estimatedChars)), 0);
    return { section, topics, demandChars: Math.min(cap, asked) };
  });
  const shares = waterFill(
    demands.map((d) => d.demandChars),
    budgetChars,
  );
  const planned: PlannedSection[] = demands.map((d, i) => {
    const { kept, dropped } = allocateTopicBudgets(d.topics, shares[i]);
    const sectionId = d.section.sectionId;
    return {
      sectionId,
      label: d.section.label,
      kind: d.section.kind,
      demandChars: d.demandChars,
      budgetChars: kept.reduce((n, t) => n + t.budgetChars, 0),
      topics: kept.map((t) => ({ ...t, sectionId })),
      dropped: dropped.map((t) => ({ ...t, sectionId })),
    };
  });
  return {
    version: TOPIC_PLAN_VERSION,
    budgetChars,
    sections: planned,
    unallocatedChars: budgetChars - planned.reduce((n, s) => n + s.budgetChars, 0),
  };
}

/**
 * The most a section may run to when it is written: its budget, plus its share
 * of the room the document has to spare at that moment — what no section asked
 * for, and what the sections already written left unused (a section that
 * overran its budget takes room away instead). The room is shared equally among
 * the sections not yet written, this one included.
 *
 * A budget is planned from estimates, and a single-call section's is a request
 * the model may undershoot by half; without this the document would stop well
 * short of its cap while its catalogue sections were being cut (#995's
 * complaint, at planning time). Never past the per-section cap, and never
 * below half the section's budget.
 *
 * `written` is the rendered length of each section finished so far, by id. It
 * is deliberately not part of a section's reuse inputs: like the document cap,
 * it is applied when the section is written and does not make a stored section
 * stale.
 */
export function sectionCeilingChars(
  plan: DocumentPlan,
  sectionId: string,
  written: ReadonlyMap<string, number>,
  sectionMaxChars: number,
): number {
  const section = plan.sections.find((s) => s.sectionId === sectionId);
  if (!section) return sectionMaxChars;
  let spare = plan.unallocatedChars;
  let unwritten = 0;
  for (const s of plan.sections) {
    const actual = written.get(s.sectionId);
    if (actual === undefined || s.sectionId === sectionId) unwritten += 1;
    else spare += s.budgetChars - actual;
  }
  const share = Math.trunc(spare / Math.max(1, unwritten));
  const ceiling = Math.max(Math.ceil(section.budgetChars / 2), section.budgetChars + share);
  return Math.min(Math.max(0, Math.floor(sectionMaxChars)), ceiling);
}

/** One line per section, for the log and for a reader of the plan. */
export function summarizeDocumentPlan(plan: DocumentPlan): Array<{
  sectionId: string;
  kind: string;
  demandChars: number;
  budgetChars: number;
  topics: number;
  dropped: number;
}> {
  return plan.sections.map((s) => ({
    sectionId: s.sectionId,
    kind: s.kind,
    demandChars: s.demandChars,
    budgetChars: s.budgetChars,
    topics: s.topics.length,
    dropped: s.dropped.length,
  }));
}

/** How a dropped topic is listed with the section's omissions. */
export function droppedTopicLabel(topic: Pick<TopicCandidate, "title">): string {
  return `${topic.title} (not planned)`;
}

/** Rounds of slack redistribution before the part fit settles. */
const MAX_PART_ROUNDS = 50;

export interface PartsFit {
  parts: string[];
  /** Parts that lost content. */
  trimmed: number;
  /** Per part, the headings of the topics cut from it (the shallowest level cut). */
  omittedTopics: string[][];
}

/**
 * Fit the written parts of one section so their total fits `total`, each part
 * measured against its own planned budget: a part within its allowance keeps
 * everything, and the allowance is the largest common MULTIPLE of the budgets
 * that makes the total fit, so room a part did not use goes to the parts that
 * overran, in proportion to what each was planned. A part that overran is cut
 * at its own tail, paragraph by paragraph (`fitSectionToBudget`, without a
 * note); room a cut leaves unused, because the next paragraph or topic is
 * larger than it, is offered to the parts still shortened.
 *
 * Parts whose total already fits are returned unchanged, whatever each one's
 * budget: a budget is a share of the section, not a cap of its own.
 */
export function fitPartsToBudgets(
  parts: readonly string[],
  budgets: readonly number[],
  total: number,
  measure: Measure = (markdown) => markdown.length,
): PartsFit {
  const lengths = parts.map((p) => measure(p));
  const none = (): string[][] => parts.map(() => []);
  if (lengths.reduce((n, l) => n + l, 0) <= total) {
    return { parts: [...parts], trimmed: 0, omittedTopics: none() };
  }
  const weights = parts.map((_, i) => Math.max(1, Math.floor(budgets[i] ?? 1)));
  // The common multiple: parts in order of how far over their budget they ran.
  const order = parts
    .map((_, i) => i)
    .sort((a, b) => lengths[a] / weights[a] - lengths[b] / weights[b] || a - b);
  let remaining = Math.max(0, total);
  let weightLeft = weights.reduce((n, w) => n + w, 0);
  const allowance = parts.map(() => Number.POSITIVE_INFINITY);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (lengths[i] * weightLeft <= remaining * weights[i]) {
      remaining -= lengths[i];
      weightLeft -= weights[i];
      continue;
    }
    for (let j = k; j < order.length; j++) {
      allowance[order[j]] = Math.floor((remaining * weights[order[j]]) / weightLeft);
    }
    break;
  }
  const fits = parts.map((part, i) =>
    lengths[i] <= allowance[i]
      ? null
      : fitSectionToBudget(part, allowance[i], [], measure, { note: false }),
  );
  const lengthOf = (i: number): number => {
    const fit = fits[i];
    return fit ? measure(fit.markdown) : lengths[i];
  };
  const open = new Set(fits.flatMap((fit, i) => (fit?.trimmed ? [i] : [])));
  for (let round = 0; round < MAX_PART_ROUNDS && open.size > 0; round++) {
    let slack = total - parts.reduce((n, _, i) => n + lengthOf(i), 0);
    if (slack <= 0) break;
    const openWeight = [...open].reduce((n, i) => n + weights[i], 0);
    const offered = slack;
    for (const i of [...open]) {
      const before = lengthOf(i);
      const budget = allowance[i] + Math.max(1, Math.floor((offered * weights[i]) / openWeight));
      const refit = fitSectionToBudget(parts[i], budget, [], measure, { note: false });
      const grew = measure(refit.markdown) - before;
      if (grew > slack) {
        open.delete(i);
        continue;
      }
      allowance[i] = budget;
      fits[i] = refit;
      slack -= grew;
      if (!refit.trimmed) open.delete(i);
    }
  }
  return {
    parts: parts.map((part, i) => fits[i]?.markdown ?? part),
    trimmed: fits.filter((fit) => fit?.trimmed).length,
    omittedTopics: fits.map((fit) => (fit?.trimmed ? fit.omittedTopics : [])),
  };
}
