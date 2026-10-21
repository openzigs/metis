/**
 * #1327 — hold one batch of a planned section to its planned share when the
 * batch is written, before the section is assembled.
 *
 * Under a topic plan (#1070) a catalogue section is written in batches, each
 * planned a share of the section, and when a cap binds each part gives up its
 * own TAIL past its share (`planOrderedFit`). But the model regroups a
 * batch's modules into thematic headings of its own, so a part's tail is
 * whichever theme it wrote last, not its lowest-priority module: run B of #995
 * lost Data Model's "Content Entities" that way, a topic that cites the
 * section's top module.
 *
 * {@link holdBatchReply} decides, as the batch is written, which of its topics
 * fit its share: its opening, then its topics MOST important first while they
 * fit, stopping at the first that does not; among equally important topics,
 * the smallest first (#1368). A topic's importance is that of
 * the highest-priority module it cites (the batch's modules are in plan
 * priority order, and every citation marker names the module facts it came
 * from). A topic that cites nothing ranked (an overview) is not moved. The
 * topics kept stay in the order the model wrote them. The rest, its OVERFLOW,
 * move to the end of the reply, most important first. A reply whose topics
 * are numbered steps is never reordered.
 *
 * Nothing is removed here. A document that fits its cap keeps every topic, as
 * it always has (#1070: a plan budget is a target, the caps are the only hard
 * limits). When a cap does bind, what a part gives up first is its own tail,
 * which is now its overflow, least important topic first; and since the fit
 * fills every part in proportion to its share, no part loses a topic within
 * its share while another part's overflow is kept. Whatever the fit removes
 * it names in the section's closing note, as before.
 *
 * Pure: no I/O and no model calls.
 */
import { units, type Measure, type Unit } from "./section-size.js";

/**
 * Bumped when what a batch is held to, or how it is asked for its length,
 * changes: a section's reuse inputs carry it, so a section written under
 * another rule is written again rather than reused. 2: tied topics smaller
 * first (#1368).
 */
export const BATCH_HOLD_VERSION = 2;

export interface BatchHoldOptions {
  /** How a reply's length is counted against its share (default: raw characters). */
  measure?: Measure;
  /**
   * The priority rank of a cited source id: lower is more important, and
   * `undefined` for an id that names none of the batch's modules.
   */
  rankOf?: (sourceId: string) => number | undefined;
}

export interface BatchHold {
  /** The reply with its overflow at its end: unchanged when nothing moved. */
  markdown: string;
  /** True when any topic was moved. */
  reordered: boolean;
  /** Headings of the topics past the share, in the order they now stand. */
  overflowTopics: string[];
}

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_TEXT = /^#{1,6}\s+(.+?)\s*#*\s*$/;
/** A topic heading that numbers its place in a sequence: `1. Fetch`, `2) Parse`, `Step 3: Store`. */
const NUMBERED = /^(?:step\s+)?\d+[.):]\s/i;
/**
 * One citation marker's inner text; a cluster may hold several ids. A marker
 * never contains `[` (ids are URL-encoded), and excluding it keeps the scan
 * linear on a reply full of unclosed `[facts:` (each attempt stops at the next).
 */
const CITATION = /\[\s*((?:facts|rag|web):[^[\]\n]*)\]/g;

/** The source ids the markers in `text` cite. */
export function citedSourceIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(CITATION)) {
    for (const token of match[1].split(/[\s,;]+/)) {
      if (/^(?:facts|rag|web):/.test(token)) ids.push(token);
    }
  }
  return ids;
}

/**
 * The heading depth a reply's topics are written at: the depth below a single
 * opening heading (`## Section` then `### Topic`), or the shallowest depth
 * when the reply opens with several headings of it. 0 when it has no heading.
 */
function topicDepthOf(all: readonly Unit[]): number {
  const depths = all.filter((u) => u.depth > 0).map((u) => u.depth);
  if (depths.length === 0) return 0;
  const top = Math.min(...depths);
  const opening = all.findIndex((u) => u.depth > 0);
  const atTop = depths.filter((d) => d === top).length;
  const deeper = depths.filter((d) => d > top);
  return atTop === 1 && all[opening].depth === top && deeper.length > 0 ? Math.min(...deeper) : top;
}

interface Topic {
  /** Indexes into the reply's units, heading first. */
  units: number[];
  cost: number;
  rank: number;
  order: number;
}

/**
 * Hold `markdown` (one batch's reply) to `maxChars`, measured by
 * `options.measure`: unchanged when it fits, or when nothing would move.
 * Otherwise its opening (the section heading and anything before the first
 * topic) and its unranked topics (citing nothing the batch reads) are counted
 * against the share first and stay in place; then its ranked topics, most
 * important first and, within a rank, smallest first (equal sizes in written
 * order), while they fit. The first that does not fit, and every
 * topic after it in priority order, is overflow: a smaller, less important
 * topic is never kept ahead of a more important one. The topics kept stay in
 * the order the model wrote them; the overflow follows, most important first.
 * A reply whose topics are numbered (`1.`, `2)`, `Step 3:`) is a sequence and
 * is left as written. A thematic break between topics is dropped (the section
 * merge writes its own before each topic). Line endings are the input's.
 */
export function holdBatchReply(
  markdown: string,
  maxChars: number,
  options: BatchHoldOptions = {},
): BatchHold {
  const measure = options.measure ?? ((text: string) => text.length);
  const unchanged: BatchHold = { markdown, reordered: false, overflowTopics: [] };
  if (measure(markdown) <= maxChars) return unchanged;
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const all = units(markdown.replace(/\r\n?/g, "\n"));
  const depth = topicDepthOf(all);
  if (depth === 0) return unchanged;
  const cost = all.map((u) => measure(u.text) + 2);
  const opening = all.findIndex((u) => u.depth > 0);
  const startsTopic = (i: number): boolean =>
    all[i].depth > 0 && all[i].depth <= depth && !(i === opening && depth > all[i].depth);
  const isBreak = (i: number): boolean => all[i].depth === 0 && THEMATIC_BREAK.test(all[i].text);

  const lead: number[] = [];
  const topics: Topic[] = [];
  all.forEach((_, i) => {
    if (startsTopic(i)) {
      topics.push({ units: [i], cost: 0, rank: Infinity, order: topics.length });
    } else if (topics.length > 0) {
      topics[topics.length - 1].units.push(i);
    } else {
      lead.push(i);
    }
  });
  // A break that only separates two topics belongs to neither.
  for (const topic of topics) {
    while (topic.units.length > 1 && isBreak(topic.units[topic.units.length - 1])) {
      topic.units.pop();
    }
  }
  while (lead.length > 0 && isBreak(lead[lead.length - 1])) lead.pop();
  const headingOf = (topic: Topic): string =>
    HEADING_TEXT.exec(all[topic.units[0]].text)?.[1] ?? all[topic.units[0]].text;
  // Numbered or step-ordered topics are a sequence the reader follows: such a
  // reply is never reordered, and only the cap's tail cut applies to it.
  if (topics.filter((topic) => NUMBERED.test(headingOf(topic))).length >= 2) return unchanged;
  const rankOf = options.rankOf ?? (() => undefined);
  for (const topic of topics) {
    topic.cost = topic.units.reduce((n, i) => n + cost[i], 0);
    for (const i of topic.units) {
      for (const id of citedSourceIds(all[i].text)) {
        const rank = rankOf(id);
        if (rank !== undefined && rank < topic.rank) topic.rank = rank;
      }
    }
  }

  // A topic that cites nothing it can rank (an overview, a glossary) stays
  // where it was written and counts against the share first, like the opening.
  const pinned = topics.filter((topic) => topic.rank === Infinity);
  let room =
    maxChars -
    lead.reduce((n, i) => n + cost[i], 0) -
    pinned.reduce((n, topic) => n + topic.cost, 0);
  // #1368 — topics of one rank (several that cite the section's top module)
  // are equally important, so the smaller goes first: as many of them fit as
  // can. In written order a large tied topic ended the prefix ahead of a small
  // one that fitted: run B's "Content Entities" (2,118 characters) moved
  // behind "Subscription Structure" (4,263). Equal sizes keep written order.
  const ranked = topics
    .filter((topic) => topic.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.cost - b.cost || a.order - b.order);
  // A priority PREFIX: the first ranked topic that does not fit ends it, so a
  // smaller, less important topic never stays while a more important one moves.
  // Within a rank nothing is lost by stopping: every tied topic after the
  // first that does not fit is at least as large.
  const fits = new Set<Topic>(pinned);
  for (const topic of ranked) {
    if (topic.cost > room) break;
    fits.add(topic);
    room -= topic.cost;
  }
  const overflow = ranked.filter((topic) => !fits.has(topic));
  const ordered = [...topics.filter((topic) => fits.has(topic)), ...overflow];
  if (ordered.every((topic, k) => topic === topics[k])) return unchanged;
  const text = (i: number): string => all[i].text;
  return {
    markdown: [...lead.map(text), ...ordered.flatMap((topic) => topic.units.map(text))]
      .join("\n\n")
      .replace(/\n/g, eol),
    reordered: true,
    overflowTopics: overflow.map(headingOf),
  };
}
