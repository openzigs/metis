/**
 * Change extraction — Epic #159 (#162).
 *
 * Turns a requirements-change document (or pasted text) into a list of
 * discrete changed requirements that the impact engine maps to code.
 *
 * The extractor is dependency-injected (`ChangeExtractor`) so the engine can
 * be driven by an LLM extractor in production or a deterministic heuristic in
 * tests. The default heuristic splits the text into paragraphs/bullets and
 * treats each as an `added` change — cheap, deterministic, and good enough to
 * seed the multi-project mapping when no LLM is wired.
 */
import { CHANGE_TYPES } from "@metis/shared";

export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangedRequirement {
  /** Head requirement id when the change maps to a tracked requirement; else null. */
  requirementId: string | null;
  title: string;
  body: string;
  changeType: ChangeType;
  /** Approximate size of the change body (chars) — feeds severity scoring. */
  bodyDelta: number;
  priorityChanged?: boolean;
  typeChanged?: boolean;
  hasChildren?: boolean;
}

export interface ChangeExtractor {
  extract(text: string): Promise<ChangedRequirement[]>;
}

const BULLET_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** A Markdown ATX heading line (`#` … `######`), capturing the heading text. */
const HEADING = /^\s*#{1,6}\s+(.*\S)\s*$/;

const TITLE_MAX = 120;

/**
 * Change-verb classifiers (#964). Applied in priority order — `removed` and
 * `modified` intents override the `added` default so a requirements delta is
 * typed by what it *does*, not blanket-typed `added`. Word-boundary anchored to
 * avoid substring false positives (e.g. "additional" ≠ "add").
 */
const REMOVED_RE =
  /\b(remov\w*|delet\w*|deprecat\w*|drop(?:ped|ping|s)?|retir\w*|eliminat\w*|discontinu\w*|no longer|sunset\w*)\b/i;
const MODIFIED_RE =
  /\b(modif\w*|chang\w*|updat\w*|renam\w*|replac\w*|revis\w*|adjust\w*|increas\w*|decreas\w*|extend\w*|migrat\w*|refactor\w*|must now|instead of)\b/i;

/** Strip a leading bullet/numbering marker from a line. */
function stripBullet(line: string): string {
  return line.replace(BULLET_PREFIX, "").trim();
}

/** Classify the change verb from the requirement text (#964). Default `added`. */
function detectChangeType(text: string): ChangeType {
  if (REMOVED_RE.test(text)) return "removed";
  if (MODIFIED_RE.test(text)) return "modified";
  return "added";
}

/** Truncate to the title budget, appending an ellipsis when clipped. */
function truncateTitle(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 3)}...` : text;
}

/**
 * Derive a scannable title (#964). A section heading, when present, names the
 * requirement; otherwise the requirement's own first sentence is used (falling
 * back to the whole body when there is no sentence break). Always clipped to the
 * title budget.
 */
function deriveTitle(body: string, heading: string | null): string {
  if (heading) return truncateTitle(heading);
  const sentenceEnd = body.search(/[.!?](?:\s|$)/);
  const firstSentence = sentenceEnd === -1 ? body : body.slice(0, sentenceEnd + 1);
  return truncateTitle(firstSentence.trim() || body);
}

/** A short label line that introduces a following list (e.g. `Requirements:`). */
const LEAD_IN_LABEL = /^(.*\S)\s*:\s*$/;

/**
 * Labels that, by definition, ELABORATE the requirement just stated rather than
 * name a group of requirements (#1136).
 *
 * The splitter's contract is that a bullet list is a requirement set only when it
 * is *introduced* as one — `Notification channels:` / `Numbered requirements:` in
 * #964's fixture each introduce a list of genuinely distinct requirements, and
 * that must keep working. `Acceptance criteria:` does not: it says "here is how
 * you verify the requirement above". Promoting its bullets is what inflated a
 * 10-requirement paste to 40 candidates and overflowed
 * `ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES` (#1101).
 *
 * Deliberately narrow — every entry describes how a requirement is *verified or
 * illustrated*, never what the system must do. Words that can legitimately head a
 * requirement list (`constraints`, `assumptions`, `rules`) are NOT here.
 */
const SUBORDINATING_LABELS = new Set([
  "ac",
  "acceptance criteria",
  "acceptance criterion",
  "acceptance test",
  "acceptance tests",
  "definition of done",
  "dod",
  "example",
  "examples",
  "note",
  "notes",
  "success criteria",
  "success criterion",
]);

/** Fold a label to its comparable form: no emphasis, no trailing `(…)`, no colon. */
function normalizeLabel(text: string): string {
  return text
    .replace(/[*_`]/g, "")
    .replace(/\([^)]*\)\s*$/, "")
    .replace(/:\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when this heading / label introduces detail of the preceding requirement. */
function isSubordinatingLabel(text: string): boolean {
  return SUBORDINATING_LABELS.has(normalizeLabel(text));
}

/**
 * The `Acceptance criteria:` lead-in form on a single line; else null. Markdown
 * emphasis is stripped first so `**Acceptance criteria:**` still reads as a label
 * — the colon is otherwise no longer line-final.
 */
function subordinatingLeadIn(line: string): string | null {
  if (BULLET_PREFIX.test(line)) return null;
  const match = line.replace(/[*_`]/g, "").trim().match(LEAD_IN_LABEL);
  if (!match) return null;
  const label = match[1].trim();
  return isSubordinatingLabel(label) ? label : null;
}

/** A block whose every line is a bullet / numbered item (2+ items). */
function isBulletList(lines: string[]): boolean {
  return lines.length > 1 && lines.every((l) => BULLET_PREFIX.test(l));
}

/**
 * Attach a subordinate block to the requirement it elaborates (#1136).
 *
 * The detail is APPENDED to the parent's body rather than discarded — an
 * acceptance criterion is exactly the kind of text the code agent should see when
 * reasoning about its requirement. `title` and `changeType` stay as the parent's
 * own text produced them: "Deleting a workspace requires confirmation" is a
 * criterion of an `added` requirement, not evidence that the requirement is a
 * `removed` one.
 */
function foldIntoParent(parent: ChangedRequirement, label: string | null, lines: string[]): void {
  const detail = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  if (detail.length === 0) return;
  const prefix = label ? `${normalizeLabelDisplay(label)}\n` : "";
  parent.body = `${parent.body}\n${prefix}${detail}`;
  parent.bodyDelta = parent.body.length;
}

/** Render a label back into the body with exactly one trailing colon. */
function normalizeLabelDisplay(label: string): string {
  return `${label.replace(/:\s*$/, "")}:`;
}

/** Emit the change(s) for one content block, titled by the section heading. */
function emitBlock(lines: string[], heading: string | null, changes: ChangedRequirement[]): void {
  if (isBulletList(lines)) {
    // List items are distinct requirements; the heading is only a grouping label,
    // so each item derives its own first-sentence title.
    for (const line of lines) {
      const body = stripBullet(line);
      if (body.length === 0) continue;
      changes.push(makeChange(body, null));
    }
  } else {
    const body = lines.map(stripBullet).join(" ").trim();
    if (body.length > 0) changes.push(makeChange(body, heading));
  }
}

/**
 * Deterministic, LLM-free change extractor. Splits on blank lines into blocks:
 *  - a Markdown heading (or a `Label:` lead-in) names the NEXT content block —
 *    heading awareness. A heading with no following body is a section divider
 *    and yields no requirement;
 *  - a bullet / numbered list yields one change per item — numbered-requirement
 *    awareness — UNLESS the list is subordinate to the requirement above it
 *    (#1136), in which case it is folded into that requirement;
 *  - anything else is a single paragraph change.
 * Each change gets a scannable title (the section heading, else the first
 * sentence) and a verb-classified {@link ChangeType} (added / modified /
 * removed) instead of a blanket `added`.
 *
 * ## The subordination contract (#1136)
 *
 * A bullet list is a requirement SET only when it is *introduced* as one:
 *   - it stands alone, with no requirement stated before it (`- A\n- B` is still
 *     one requirement per bullet — the headline paste shape, never regress it);
 *   - or a heading / `Label:` lead-in introduces it (`## Requirements`,
 *     `Notification channels:`), which resets the subordination context.
 *
 * A bullet list is subordinate DETAIL when it continues the requirement just
 * stated: either directly, with no intervening label at all, or introduced by a
 * label that elaborates a requirement rather than naming a group of them (see
 * {@link SUBORDINATING_LABELS}). Detail is appended to its parent, never dropped.
 *
 * Before #1136, ten requirements each carrying three acceptance-criteria bullets
 * parsed as FORTY candidates, so a perfectly ordinary three-requirement paste
 * already overflowed the eight-candidate cap and the tail was cut (#1101). The
 * defect was the unit being counted, not the size of the cap.
 *
 * This is the extractor's pure, synchronous core, exported (#1004) so the
 * markdown export can re-run the SAME splitter at serialize time without an
 * await. One implementation only: the export's "how many requirements did this
 * paste hold?" question can never drift from how the engine actually split it.
 */
export function extractChangesHeuristically(text: string): ChangedRequirement[] {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return [];

  const blocks = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const changes: ChangedRequirement[] = [];
  // A heading / lead-in label names the next content block, then clears.
  let pendingHeading: string | null = null;
  // #1136 — a subordinating label seen on (or as) the previous block marks the
  // NEXT block as detail of the requirement already emitted. A `null` label means
  // the label text is already inside the parent's body, so it is not re-rendered.
  let pendingSubordination: { label: string | null } | null = null;
  // #1136 — the previous content block stated ONE requirement as a paragraph, so a
  // bullet list following it with no intervening label is that requirement's
  // detail. Reset by any heading / lead-in, which starts a fresh context.
  let previousBlockStatedOneRequirement = false;

  /** Fold into the most recent requirement; false when there is none to fold into. */
  const fold = (label: string | null, lines: string[]): boolean => {
    const parent = changes[changes.length - 1];
    if (!parent) return false;
    foldIntoParent(parent, label, lines);
    return true;
  };

  for (const block of blocks) {
    const lines = block
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    // A leading ATX heading in this block.
    const headingMatch = lines[0].match(HEADING);
    if (headingMatch) {
      const headingText = headingMatch[1].trim();
      const rest = lines.slice(1);
      if (isSubordinatingLabel(headingText)) {
        // `### Acceptance criteria` — detail of the requirement above, not a section.
        pendingHeading = null;
        previousBlockStatedOneRequirement = false;
        if (rest.length === 0) {
          pendingSubordination = { label: headingText };
        } else if (!fold(headingText, rest)) {
          // Nothing to subordinate to — keep the pre-#1136 behaviour rather than
          // silently discard text the user typed.
          emitBlock(rest, headingText, changes);
        }
        continue;
      }
      pendingSubordination = null;
      if (rest.length === 0) {
        // Bare heading — names the next content block.
        pendingHeading = headingText;
        previousBlockStatedOneRequirement = false;
      } else {
        // Heading with inline body — names THIS block.
        emitBlock(rest, headingText, changes);
        pendingHeading = null;
        previousBlockStatedOneRequirement = !isBulletList(rest);
      }
      continue;
    }

    if (lines.length === 1 && !BULLET_PREFIX.test(lines[0])) {
      const subordinatingLabel = subordinatingLeadIn(lines[0]);
      if (subordinatingLabel) {
        pendingSubordination = { label: subordinatingLabel };
        pendingHeading = null;
        previousBlockStatedOneRequirement = false;
        continue;
      }
      // A single-line `Label:` lead-in also names the next content block.
      const leadIn = lines[0].match(LEAD_IN_LABEL);
      if (leadIn) {
        pendingHeading = leadIn[1].trim();
        pendingSubordination = null;
        previousBlockStatedOneRequirement = false;
        continue;
      }
    }

    // Content block. Resolve subordination BEFORE consuming the pending heading.
    const subordination = pendingSubordination;
    pendingSubordination = null;
    const bulletList = isBulletList(lines);
    // `Acceptance criteria:` heading the block itself, with its detail inline.
    const inlineLabel = lines.length > 1 ? subordinatingLeadIn(lines[0]) : null;

    const folded =
      (subordination !== null && fold(subordination.label, lines)) ||
      (inlineLabel !== null && fold(null, lines)) ||
      (bulletList && previousBlockStatedOneRequirement && fold(null, lines));
    if (folded) {
      // Two adjacent detail blocks are ambiguous; only the block immediately after
      // a stated requirement is claimed as its detail.
      previousBlockStatedOneRequirement = false;
      continue;
    }

    const heading = subordination?.label ?? pendingHeading;
    pendingHeading = null;
    emitBlock(lines, heading, changes);
    previousBlockStatedOneRequirement = !bulletList;
    // `R1: …\nAcceptance criteria:` — the label closes this block and introduces
    // the next one, which is therefore this requirement's detail.
    if (lines.length > 1 && subordinatingLeadIn(lines[lines.length - 1]) !== null) {
      pendingSubordination = { label: null };
    }
  }
  return changes;
}

/** The injectable extractor the impact engine is wired with (async by contract). */
export const heuristicChangeExtractor: ChangeExtractor = {
  async extract(text: string): Promise<ChangedRequirement[]> {
    return extractChangesHeuristically(text);
  },
};

function makeChange(body: string, heading: string | null = null): ChangedRequirement {
  return {
    requirementId: null,
    title: deriveTitle(body, heading),
    body,
    // Classify from the heading + body so "## Deprecated endpoints" + body both
    // inform the verb.
    changeType: detectChangeType(`${heading ?? ""} ${body}`),
    bodyDelta: body.length,
  };
}
