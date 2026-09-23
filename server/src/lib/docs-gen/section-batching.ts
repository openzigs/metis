/**
 * #157 — batched synthesis for the enumerative section groups (Business Rules,
 * Key Workflows, Calculations, Data Model).
 *
 * Those sections are catalogs: their length grows with the number of modules,
 * so no single call can hold them. On onyourleft (143 TypeScript modules) the
 * Rules section read ~10% of the modules and was still cut off at the output
 * cap — 32,169 chars at 8,192 tokens (run 7), 63,719 chars at 16,384 tokens
 * (run 9). What bounds a call is its OUTPUT, so a batch is sized by an estimate
 * of what it will write as well as by what it reads.
 *
 * This module holds the pure parts, with no I/O and no model:
 *   - the output estimate and the batch planner,
 *   - the re-split rule for a batch whose reply was cut off anyway,
 *   - the deterministic merge of the batch replies into one section,
 *   - the aggregation of per-batch faithfulness into one section score.
 */
import type { FaithfulnessResult } from "./grounding/citation-validator.js";

/**
 * Characters per OUTPUT token used to turn a token cap into a character budget.
 * Measured on onyourleft's cut-off sections: 32,218 chars at 8,192 tokens
 * (3.93) for Rules, 30,939 (3.78) for Calculations. 3.5 is deliberately below
 * both, so the budget errs toward smaller batches.
 */
export const CHARS_PER_OUTPUT_TOKEN = 3.5;

/**
 * Fraction of the output cap a batch is PLANNED to fill. The estimate is a
 * heuristic; the remaining 40% is headroom for a module that writes more than
 * its facts suggest. A batch that still runs to the cap is re-split.
 */
export const BATCH_OUTPUT_MARGIN = 0.6;

/**
 * Output characters per character of the module's topic facts. The rules
 * prompt asks for a name, condition, action and exceptions per rule, which is
 * longer than the one-line fact it came from: run 7's Rules section wrote
 * 32,218 chars from roughly 30,000 chars of rules facts and was still cut off,
 * so the true ratio is above 1.0.
 */
export const OUTPUT_CHARS_PER_TOPIC_CHAR = 1.25;

/**
 * Output characters per mined rule (#155). A mined-rule inventory line is a
 * compact `- [kind] expression — file:line` (~100 chars), but each one becomes a
 * full rule entry in the section, which is what this measures.
 */
export const OUTPUT_CHARS_PER_MINED_RULE = 300;

/** Fixed per-module output overhead: headings, a table header, a lead sentence. */
export const OUTPUT_CHARS_PER_MODULE = 300;

/**
 * A cut-off batch is re-split only when its own estimate is at least this
 * fraction of the batch output budget. A batch estimated far below the cap that
 * runs to the cap anyway is not explained by its size — the model is repeating
 * itself (#165's runaway shape) — and splitting it would only buy more
 * full-cap calls.
 */
export const MIN_SPLIT_BUDGET_FRACTION = 0.25;

/** The character budget a batch's estimated output is planned against. */
export function batchOutputBudgetChars(maxTokens: number): number {
  return Math.max(1, Math.floor(maxTokens * CHARS_PER_OUTPUT_TOKEN * BATCH_OUTPUT_MARGIN));
}

/**
 * Estimated output characters for one module in a batched section.
 *
 * @param topicChars - length of the module's rendered topic slices for this
 *   section (not its summary, which is context rather than catalog content, and
 *   not the mined inventory, counted separately below).
 * @param minedRules - the number of mined rules the module's entry actually
 *   RENDERS (the capped inventory), never the uncapped total.
 */
export function estimateModuleOutputChars(input: {
  topicChars: number;
  minedRules: number;
}): number {
  return Math.ceil(
    OUTPUT_CHARS_PER_MODULE +
      input.topicChars * OUTPUT_CHARS_PER_TOPIC_CHAR +
      input.minedRules * OUTPUT_CHARS_PER_MINED_RULE,
  );
}

/** One module as the planner sees it. */
export interface BatchCandidate<T> {
  item: T;
  /** Characters this module adds to the batch's facts input. */
  inputChars: number;
  /** Estimated characters this module adds to the batch's reply. */
  outputChars: number;
}

export interface BatchLimits {
  /** Facts characters one call may read (the provider's `factsCharCap`). */
  inputCap: number;
  /** Estimated reply characters one call may write ({@link batchOutputBudgetChars}). */
  outputBudget: number;
}

/**
 * Split modules into batches, in the given (relevance) order, so that each
 * batch's facts fit `inputCap` AND its estimated reply fits `outputBudget`.
 *
 * Greedy and order-preserving: a batch is closed when the next module would
 * push either total over its limit. A module that exceeds a limit on its own
 * still gets a batch to itself — it is never dropped — and the caller reports
 * it if its reply is cut off. Every candidate appears in exactly one batch.
 */
export function planBatches<C extends BatchCandidate<unknown>>(
  candidates: readonly C[],
  limits: BatchLimits,
): C[][] {
  const batches: C[][] = [];
  let current: C[] = [];
  let input = 0;
  let output = 0;
  for (const c of candidates) {
    const overflows =
      current.length > 0 &&
      (input + c.inputChars > limits.inputCap || output + c.outputChars > limits.outputBudget);
    if (overflows) {
      batches.push(current);
      current = [];
      input = 0;
      output = 0;
    }
    current.push(c);
    input += c.inputChars;
    output += c.outputChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Total estimated output of a batch. */
export function batchOutputChars(batch: readonly BatchCandidate<unknown>[]): number {
  return batch.reduce((sum, c) => sum + c.outputChars, 0);
}

/**
 * Split a batch in two at the point that best balances estimated output, in
 * order. Both halves are non-empty; a single-module batch cannot be split and
 * is returned as `null`.
 */
export function splitBatch<C extends BatchCandidate<unknown>>(
  batch: readonly C[],
): [C[], C[]] | null {
  if (batch.length < 2) return null;
  const total = batchOutputChars(batch);
  let best = 1;
  let bestGap = Infinity;
  let left = 0;
  for (let i = 1; i < batch.length; i++) {
    left += batch[i - 1].outputChars;
    const gap = Math.abs(total - 2 * left);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return [batch.slice(0, best), batch.slice(best)];
}

/**
 * Whether a batch whose reply was cut off by the output cap should be split and
 * regenerated. Bounded three ways so a model that always runs to the cap cannot
 * loop (#165): a single module cannot be split; the section's re-split budget
 * must not be spent; and the batch must be large enough that its size can
 * explain the cut-off ({@link MIN_SPLIT_BUDGET_FRACTION}).
 */
export function shouldResplit(
  batch: readonly BatchCandidate<unknown>[],
  truncated: boolean,
  resplitsLeft: number,
  outputBudget: number,
): boolean {
  return (
    truncated &&
    batch.length > 1 &&
    resplitsLeft > 0 &&
    batchOutputChars(batch) >= MIN_SPLIT_BUDGET_FRACTION * outputBudget
  );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

type BlockKind = "h2" | "h3" | "h4" | "fence" | "table" | "item" | "para";

interface Block {
  kind: BlockKind;
  text: string;
  /** A blank line preceded this block in the batch's reply. */
  blankBefore: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s+/;
const TABLE_LINE = /^\s*\|/;
const INDENTED = /^(?: {2,}|\t)/;

function isFenceClose(line: string, open: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && m[1][0] === open[0] && m[1].length >= open.length;
}

/**
 * Consume a fenced block starting at `lines[start]`. An UNCLOSED fence runs to
 * the end of the reply and is closed here, so it can never swallow the next
 * batch's content once the replies are joined.
 */
function readFence(lines: string[], start: number): { text: string; next: number } {
  const open = FENCE_OPEN.exec(lines[start])![1];
  const body = [lines[start]];
  let i = start + 1;
  for (; i < lines.length; i++) {
    body.push(lines[i]);
    if (isFenceClose(lines[i], open)) return { text: body.join("\n"), next: i + 1 };
  }
  body.push(open);
  return { text: body.join("\n"), next: i };
}

function startsBlock(line: string): boolean {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    LIST_ITEM.test(line) ||
    TABLE_LINE.test(line)
  );
}

/** Split one batch reply into blocks. Fences are atomic; headings inside them are not headings. */
function tokenize(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let blankBefore = false;
  let i = 0;
  const push = (kind: BlockKind, text: string): void => {
    blocks.push({ kind, text, blankBefore });
    blankBefore = false;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      blankBefore = true;
      i++;
      continue;
    }
    if (FENCE_OPEN.test(line)) {
      const { text, next } = readFence(lines, i);
      push("fence", text);
      i = next;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const kind: BlockKind | null =
        level === 2 ? "h2" : level === 3 ? "h3" : level === 4 ? "h4" : null;
      push(kind ?? "para", kind ? heading[2] : line);
      i++;
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      // Dropped: separators are re-inserted between topics when rendering.
      i++;
      continue;
    }
    if (TABLE_LINE.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_LINE.test(lines[i])) rows.push(lines[i++]);
      push("table", rows.join("\n"));
      continue;
    }
    if (LIST_ITEM.test(line)) {
      // The item plus its indented continuation (nested bullets, wrapped lines,
      // indented fences), including across blank lines inside the item.
      const body = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          let j = i;
          while (j < lines.length && lines[j].trim() === "") j++;
          if (j < lines.length && INDENTED.test(lines[j])) {
            body.push(...lines.slice(i, j));
            i = j;
            continue;
          }
          break;
        }
        if (!INDENTED.test(l)) break;
        if (FENCE_OPEN.test(l.trimStart())) {
          const { text, next } = readFence(lines, i);
          body.push(text);
          i = next;
          continue;
        }
        body.push(l);
        i++;
      }
      push("item", body.join("\n"));
      continue;
    }
    const body = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) {
      body.push(lines[i++]);
    }
    push("para", body.join("\n"));
  }
  return blocks;
}

/**
 * Normalise text for identity: formatting, list markers and numbering (on every
 * line, so a renumbered step list inside an entry still matches), case and
 * spacing do not make a rule new.
 */
export function entryKey(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.:;,\s]+$/, "")
    .trim();
}

/** Normalise a heading so "Validation Rules" and "validation rules:" are one topic. */
export function topicKey(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A paragraph that introduces the list after it ("**Variables:**", "Edge cases:"). */
function isLabel(text: string): boolean {
  const t = text.trim();
  return t.endsWith(":") || /^\*\*[^*]+\*\*:?$/.test(t);
}

interface EntryPart {
  text: string;
  blankBefore: boolean;
}

interface Entry {
  kind: "table" | "other";
  parts: EntryPart[];
}

interface ParsedSubtopic {
  heading: string | null;
  entries: Entry[];
}

interface ParsedTopic {
  heading: string | null;
  subtopics: ParsedSubtopic[];
}

interface ParsedSection {
  h2: string | null;
  topics: ParsedTopic[];
}

/**
 * Parse a batch reply into H3 topics → H4 subtopics → entries. An entry is one
 * catalog item: a list item with its nested lines, a table, a fence, or a
 * paragraph together with the list it introduces — so a "**Variables:**" list
 * is never taken apart and deduplicated bullet by bullet against another
 * formula's. Content before the first H3 belongs to a heading-less preamble
 * topic. A second H2 in one reply is treated as a topic.
 */
function parseSection(markdown: string): ParsedSection {
  const preamble: ParsedTopic = { heading: null, subtopics: [] };
  const section: ParsedSection = { h2: null, topics: [preamble] };
  let topic = preamble;
  let sub: ParsedSubtopic | null = null;
  let entry: Entry | null = null;
  // Which following list items belong to the current entry: any item after a
  // label paragraph ("Edge cases:"), only a TIGHT list after a plain paragraph.
  let attach: "any" | "tight" | null = null;
  for (const block of tokenize(markdown)) {
    if (block.kind === "h2" && section.h2 === null) {
      section.h2 = block.text;
      continue;
    }
    if (block.kind === "h2" || block.kind === "h3") {
      topic = { heading: block.text, subtopics: [] };
      section.topics.push(topic);
      sub = null;
      entry = null;
      attach = null;
      continue;
    }
    if (block.kind === "h4") {
      sub = { heading: block.text, entries: [] };
      topic.subtopics.push(sub);
      entry = null;
      attach = null;
      continue;
    }
    const part: EntryPart = { text: block.text, blankBefore: block.blankBefore };
    if (
      block.kind === "item" &&
      entry !== null &&
      (attach === "any" || (attach === "tight" && !block.blankBefore))
    ) {
      entry.parts.push(part);
      continue;
    }
    if (!sub) {
      sub = { heading: null, entries: [] };
      topic.subtopics.push(sub);
    }
    entry = { kind: block.kind === "table" ? "table" : "other", parts: [part] };
    sub.entries.push(entry);
    attach = block.kind === "para" ? (isLabel(block.text) ? "any" : "tight") : null;
  }
  return section;
}

function renderEntry(parts: readonly EntryPart[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.text : `${p.blankBefore ? "\n\n" : "\n"}${p.text}`))
    .join("");
}

/** Normalised entries at least this long are deduplicated across the whole section. */
const SECTION_WIDE_DEDUP_MIN_CHARS = 40;

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}/;

interface MergedSubtopic {
  heading: string | null;
  entries: string[];
  /** Some batch contributed an entry here (so an empty result means all were duplicates). */
  hadEntries: boolean;
}

interface MergedTopic {
  heading: string | null;
  subtopics: Map<string, MergedSubtopic>;
}

/**
 * Merge the replies of a batched section into one section, deterministically.
 *
 * Replies are taken in batch order (which is module relevance order). Topics
 * (H3) and subtopics (H4) with the same normalised heading are merged, in order
 * of first appearance; within each, entries follow in batch order, then in the
 * order the batch wrote them. An entry is dropped when an EARLIER batch already
 * contributed an identical one (after normalising numbering, emphasis, case and
 * spacing) — within one batch nothing is removed, since that is the model's own
 * structure. Substantive entries are matched section-wide, short ones only
 * within their subtopic, so a short "None." under one formula never removes
 * another formula's. Table rows repeated under the same header are dropped the
 * same way; the header stays. Fences are atomic and an unclosed one is closed
 * at the end of its own reply.
 *
 * The H2 is the first one any reply used, else `## ${fallbackHeading}`.
 * Thematic breaks are dropped and one `---` is placed before each topic.
 */
export function mergeBatchSections(replies: readonly string[], fallbackHeading: string): string {
  let h2: string | null = null;
  const topics = new Map<string, MergedTopic>();
  const seen = new Map<string, number>();
  const firstSeenBy = (key: string, batch: number): boolean => {
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, batch);
      return true;
    }
    return at === batch;
  };

  replies.forEach((reply, batch) => {
    const parsed = parseSection(reply);
    h2 ??= parsed.h2;
    for (const t of parsed.topics) {
      const tk = t.heading === null ? "" : topicKey(t.heading);
      let topic = topics.get(tk);
      if (!topic) {
        topic = { heading: t.heading, subtopics: new Map() };
        topics.set(tk, topic);
      }
      for (const s of t.subtopics) {
        const sk = s.heading === null ? "" : topicKey(s.heading);
        let sub = topic.subtopics.get(sk);
        if (!sub) {
          sub = { heading: s.heading, entries: [], hadEntries: false };
          topic.subtopics.set(sk, sub);
        }
        for (const e of s.entries) {
          sub.hadEntries = true;
          if (e.kind === "table") {
            const kept = mergeTableRows(e.parts[0].text, `${tk}\u0000${sk}`, batch, firstSeenBy);
            if (kept !== null) sub.entries.push(kept);
            continue;
          }
          const text = renderEntry(e.parts);
          const key = entryKey(text);
          const scoped =
            key.length >= SECTION_WIDE_DEDUP_MIN_CHARS
              ? `*\u0000${key}`
              : `${tk}\u0000${sk}\u0000${key}`;
          if (firstSeenBy(scoped, batch)) sub.entries.push(text);
        }
      }
    }
  });

  const out: string[] = [`## ${h2 ?? fallbackHeading}`];
  for (const topic of topics.values()) {
    const body: string[] = [];
    for (const sub of topic.subtopics.values()) {
      if (sub.entries.length === 0 && sub.hadEntries) continue;
      if (sub.heading !== null) body.push(`#### ${sub.heading}`);
      body.push(...sub.entries);
    }
    if (topic.heading === null) {
      out.push(...body);
      continue;
    }
    if (body.length === 0 && [...topic.subtopics.values()].some((s) => s.hadEntries)) continue;
    if (out.length > 1) out.push("---");
    out.push(`### ${topic.heading}`, ...body);
  }
  return out.join("\n\n");
}

/**
 * Keep a table's header and separator, dropping data rows an earlier batch
 * already wrote under the same header in the same subtopic. `null` when every
 * data row was a duplicate.
 */
function mergeTableRows(
  table: string,
  scope: string,
  batch: number,
  firstSeenBy: (key: string, batch: number) => boolean,
): string | null {
  const rows = table.split("\n");
  const head =
    rows.length > 1 && TABLE_SEPARATOR.test(rows[1]) ? rows.slice(0, 2) : rows.slice(0, 1);
  const data = rows.slice(head.length);
  if (data.length === 0) return table;
  const headerKey = entryKey(head[0]);
  const kept = data.filter((row) =>
    firstSeenBy(`${scope}\u0000${headerKey}\u0000${entryKey(row)}`, batch),
  );
  return kept.length === 0 ? null : [...head, ...kept].join("\n");
}

// ---------------------------------------------------------------------------
// Faithfulness across batches
// ---------------------------------------------------------------------------

/**
 * Combine the per-batch faithfulness results of one section (#157). Each batch
 * was judged against its OWN facts, so claim lists stay small; the section's
 * score is the pooled ratio — supported claims over total claims across every
 * verified batch — not an average of ratios, so a batch with two claims does
 * not weigh as much as one with two hundred.
 *
 * Unverified batches contribute no claims. The section is verified when any
 * batch was. An unparseable reply in any batch is carried through (claims
 * before verdicts), and so is a cut-off one, so the section warning still says
 * that part of it went unchecked. `null` when there are no results.
 */
export function aggregateFaithfulness(
  section: string,
  results: readonly FaithfulnessResult[],
): FaithfulnessResult | null {
  if (results.length === 0) return null;
  const verified = results.filter((r) => r.verified);
  const totalClaims = verified.reduce((n, r) => n + r.totalClaims, 0);
  const supportedClaims = verified.reduce((n, r) => n + r.supportedClaims, 0);
  const unparseable = results.some((r) => r.unparseable === "claims")
    ? ("claims" as const)
    : results.some((r) => r.unparseable === "verdicts")
      ? ("verdicts" as const)
      : undefined;
  return {
    section,
    totalClaims,
    supportedClaims,
    faithfulness: totalClaims === 0 ? 1 : supportedClaims / totalClaims,
    verified: verified.length > 0,
    unsupportedClaims: verified.flatMap((r) => r.unsupportedClaims),
    supportedAttributions: verified.flatMap((r) => r.supportedAttributions),
    ...(unparseable ? { unparseable } : {}),
    ...(results.some((r) => r.truncated) ? { truncated: true as const } : {}),
  };
}
