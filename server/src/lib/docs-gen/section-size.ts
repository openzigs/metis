/**
 * #741 — bounded section and document length.
 *
 * In #706 run 3 the regenerated BRD was 2.19 MB and its "Business Rules &
 * Policies" section alone 1.1 MB: an exhaustive per-function catalogue (srcset
 * descriptor parsing, URI scheme allowlists) that no analyst could review,
 * whose every passage was then fact-checked at the cost of 800+ grounding
 * calls. The facts were right; the document was unusable.
 *
 * Length is now bounded twice:
 *
 * 1. At the source. A batched catalogue section gets a word budget per batch,
 *    derived from {@link resolveSectionMaxChars} and the batch's share of the
 *    section's estimated length ({@link sectionBudgetScale}), and is asked for
 *    business-level rules rather than every implementation check. Scaling the
 *    estimates also lets the planner pack more modules into each call, so the
 *    section takes fewer calls as well as writing fewer words.
 * 2. As a guarantee. Whatever a model writes, {@link fitSectionToBudget} keeps
 *    the section's leading content whole — paragraph by paragraph, never inside
 *    a code fence, math block or table, never mid-sentence — and closes it with
 *    a note naming the topics it left out. {@link fitSectionsToDocumentBudget}
 *    does the same across the document, shortening the longest sections first.
 *
 * Pure: no I/O and no model calls.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";

/** Registry key: the longest one section may be, in markdown characters. */
export const SECTION_MAX_CHARS_KEY = "DOCS_GEN_SECTION_MAX_CHARS";
/** Registry key: the longest a document's body may be, in markdown characters. */
export const DOCUMENT_MAX_CHARS_KEY = "DOCS_GEN_DOCUMENT_MAX_CHARS";
/** About 20 printed pages of markdown prose. */
export const DEFAULT_SECTION_MAX_CHARS = 60_000;
/**
 * About 80 pages. The run-3 Architecture document, which reviewers found usable,
 * was 212 KB; its BRD was ten times that.
 */
export const DEFAULT_DOCUMENT_MAX_CHARS = 250_000;
/** The smallest settings the registry accepts (shorter is not a document). */
export const MIN_SECTION_MAX_CHARS = 5_000;
export const MIN_DOCUMENT_MAX_CHARS = 10_000;
/** Markdown characters per English word, for the budget a prompt states. */
export const CHARS_PER_WORD = 6;
/** Room kept for the closing note, so a fitted section stays within its budget. */
const NOTE_RESERVE = 900;
/** Most omitted topic names the note lists. */
const NOTE_TOPIC_LIMIT = 12;

function readCap(config: ConfigService, key: string, fallback: number, min: number): number {
  const raw = config.getNumber(key, fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.floor(raw));
}

/** The configured per-section cap (default {@link DEFAULT_SECTION_MAX_CHARS}). */
export function resolveSectionMaxChars(config: ConfigService = getConfigService()): number {
  return readCap(config, SECTION_MAX_CHARS_KEY, DEFAULT_SECTION_MAX_CHARS, MIN_SECTION_MAX_CHARS);
}

/** The configured whole-document cap (default {@link DEFAULT_DOCUMENT_MAX_CHARS}). */
export function resolveDocumentMaxChars(config: ConfigService = getConfigService()): number {
  return readCap(
    config,
    DOCUMENT_MAX_CHARS_KEY,
    DEFAULT_DOCUMENT_MAX_CHARS,
    MIN_DOCUMENT_MAX_CHARS,
  );
}

/**
 * The factor a batched section's per-module output estimates are scaled by so
 * the whole section is planned to fit `sectionMaxChars` (1 when it already fits).
 */
export function sectionBudgetScale(estimatedChars: number, sectionMaxChars: number): number {
  if (!(estimatedChars > 0)) return 1;
  return Math.min(1, sectionMaxChars / estimatedChars);
}

/** A batch's word budget, from its (already scaled) estimated characters. */
export function batchWordBudget(estimatedChars: number): number {
  return Math.max(150, Math.round(estimatedChars / CHARS_PER_WORD / 50) * 50);
}

/** One indivisible piece of a section: a heading line, or a whole paragraph/fence/table. */
interface Unit {
  text: string;
  /** Heading depth (2–6) for a heading line; 0 for content. */
  depth: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Split markdown into units. A blank line ends a unit, except inside a code
 * fence or a `$$` math block, which always stay whole; a heading line is its
 * own unit.
 */
function units(markdown: string): Unit[] {
  const out: Unit[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;
  let math = false;
  const flush = (): void => {
    if (buffer.length > 0) out.push({ text: buffer.join("\n"), depth: 0 });
    buffer = [];
  };
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (fence) {
      buffer.push(line);
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (math) {
      buffer.push(line);
      if (trimmed.endsWith("$$")) math = false;
      continue;
    }
    const fenceOpen = FENCE.exec(line);
    if (fenceOpen) {
      buffer.push(line);
      fence = fenceOpen[1];
      continue;
    }
    if (trimmed.startsWith("$$") && (trimmed === "$$" || !trimmed.slice(2).endsWith("$$"))) {
      buffer.push(line);
      math = true;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({ text: line, depth: heading[1].length });
      continue;
    }
    if (trimmed === "") {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

const headingText = (unit: Unit): string => HEADING.exec(unit.text)?.[2] ?? unit.text;

/**
 * The sentences of `text` that fit `max` characters, whole. Used only when a
 * section's first paragraph alone is over budget.
 */
function leadingSentences(text: string, max: number): string {
  const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) ?? [text];
  let kept = "";
  for (const sentence of sentences) {
    if (kept.length + sentence.length > max) break;
    kept += sentence;
  }
  return kept.trim();
}

/**
 * A unit that may be cut at a sentence: not a code fence, a `$$` math block or
 * a table, whose syntax a cut would leave unclosed.
 */
function isProse(text: string): boolean {
  const lead = text.trimStart();
  return !(FENCE.test(lead) || lead.startsWith("$$") || lead.startsWith("|"));
}

export interface FitResult {
  markdown: string;
  /** True when content was left out. */
  trimmed: boolean;
  /** Headings of the topics left out (the shallowest level that was cut). */
  omittedTopics: string[];
  /** Length before fitting. */
  originalChars: number;
}

function omissionNote(omitted: readonly string[], maxChars: number): string {
  const listed = omitted.slice(0, NOTE_TOPIC_LIMIT).map((t) => t.replace(/\s+/g, " ").slice(0, 80));
  const more = omitted.length - listed.length;
  const topics =
    listed.length > 0
      ? ` ${omitted.length} further topic${omitted.length === 1 ? " was" : "s were"} left out: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`
      : " Its remaining detail was left out.";
  return `> **Shortened for length.** This section is limited to about ${Math.round(maxChars / 1000)}k characters (DOCS_GEN_SECTION_MAX_CHARS / DOCS_GEN_DOCUMENT_MAX_CHARS).${topics} Narrow the document with path prefixes, or raise the limit, for the full detail.`;
}

/**
 * Fit one section into `maxChars`: its units are kept in order while they fit,
 * a trailing heading with nothing under it is dropped, and a note lists the
 * topics left out. A section already within budget is returned unchanged.
 */
export function fitSectionToBudget(markdown: string, maxChars: number): FitResult {
  const originalChars = markdown.length;
  if (originalChars <= maxChars) {
    return { markdown, trimmed: false, omittedTopics: [], originalChars };
  }
  const all = units(markdown);
  const room = Math.max(0, maxChars - NOTE_RESERVE);
  const kept: Unit[] = [];
  let used = 0;
  let cut = all.length;
  for (let i = 0; i < all.length; i++) {
    const cost = all[i].text.length + 2;
    if (used + cost > room) {
      cut = i;
      break;
    }
    kept.push(all[i]);
    used += cost;
  }
  // Nothing but headings fits: keep the first paragraph's leading sentences —
  // only when it is prose. A code fence, math block or table is cut before,
  // never inside, so nothing is left unclosed (#867).
  if (!kept.some((u) => u.depth === 0)) {
    const first = all.findIndex((u) => u.depth === 0);
    if (first >= 0) {
      const heads = all.slice(0, first).filter((u) => u.depth > 0);
      const headChars = heads.reduce((n, u) => n + u.text.length + 2, 0);
      const lead = isProse(all[first].text)
        ? leadingSentences(all[first].text, Math.max(0, room - headChars))
        : "";
      kept.length = 0;
      kept.push(...heads);
      if (lead) kept.push({ text: lead, depth: 0 });
      cut = first + 1;
    }
  }
  // Never end on a heading with no content under it.
  while (kept.length > 1 && kept[kept.length - 1].depth > 0) {
    kept.pop();
    cut -= 1;
  }
  const dropped = all.slice(Math.max(0, cut));
  const droppedHeadings = dropped.filter((u) => u.depth > 0);
  const level = droppedHeadings.reduce((min, u) => Math.min(min, u.depth), 7);
  const omittedTopics = droppedHeadings.filter((u) => u.depth === level).map(headingText);
  const body = kept.map((u) => u.text).join("\n\n");
  return {
    markdown: `${body}\n\n${omissionNote(omittedTopics, maxChars)}`,
    trimmed: true,
    omittedTopics,
    originalChars,
  };
}

/**
 * Fit sections so their total fits `maxChars`. Sections at or below a common
 * allowance keep everything; the allowance is the largest one that makes the
 * total fit (water-filling), so the longest sections are shortened first.
 */
export function fitSectionsToDocumentBudget(
  sections: readonly string[],
  maxChars: number,
): { sections: string[]; trimmed: number } {
  const lengths = sections.map((s) => s.length);
  const total = lengths.reduce((n, l) => n + l, 0);
  if (total <= maxChars) return { sections: [...sections], trimmed: 0 };
  const sorted = [...lengths].sort((a, b) => a - b);
  let remaining = maxChars;
  let allowance = 0;
  for (let i = 0; i < sorted.length; i++) {
    const share = Math.floor(remaining / (sorted.length - i));
    if (sorted[i] <= share) {
      remaining -= sorted[i];
      continue;
    }
    allowance = share;
    break;
  }
  let trimmed = 0;
  const fitted = sections.map((section) => {
    if (section.length <= allowance) return section;
    trimmed += 1;
    return fitSectionToBudget(section, Math.max(allowance, NOTE_RESERVE * 2)).markdown;
  });
  return { sections: fitted, trimmed };
}
