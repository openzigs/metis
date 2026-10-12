/**
 * #1036 — read a pasted issue as ONE change with sub-aspects.
 *
 * The heuristic splitter (`extract-changes.ts`) treats every heading, paragraph
 * and bullet as its own requirement. That is right for a requirements document
 * and wrong for an issue: walkthrough run 7 turned each of six GitHub issues into
 * 5 to 12 "requirement changes" ("Feature Summary", "Version", a bare URL,
 * "Thank you for Miniflux!"), mapped every fragment to code on its own, and so
 * named 57 to 115 files per issue at 1 to 3% file precision.
 *
 * This module recognises the issue SHAPE — a title followed by sections whose
 * headings come from the vocabulary issue templates use — and models the text as
 * `{ primaryRequest, subAspects, context, ignored }`:
 *   - the primary request is what is being asked for (the title, plus a summary
 *     section when it adds something);
 *   - a sub-aspect elaborates the request (proposed solution, expected behaviour);
 *   - context explains it (the problem, steps to reproduce, alternatives);
 *   - ignored text carries no request at all (an empty form field, a version, a
 *     bare URL, a sign-off). It is returned with the reason, never silently lost.
 *
 * The mode is chosen from the input's shape: anything that is not recognisably
 * one issue keeps the heuristic splitter, unchanged. Deterministic and pure — an
 * LLM extractor can replace it later behind the same {@link ChangeExtractor}.
 */
import {
  extractChangesHeuristically,
  type ChangedRequirement,
  type ChangeExtractor,
  type ChangeType,
} from "./extract-changes.js";

/** One headed section of the issue, with the noise lines already removed. */
export interface ChangeRequestSection {
  heading: string;
  text: string;
}

/** Why a piece of the paste carries no request. */
export type IgnoredReason = "placeholder" | "url" | "version" | "environment" | "sign-off";

export interface IgnoredFragment {
  /** The section it came from (`""` for text before the first heading). */
  heading: string;
  text: string;
  reason: IgnoredReason;
}

export type ChangeRequestKind = "feature" | "bug" | "unknown";

export interface ChangeRequest {
  /** The issue title, without a template's `[Feature]:` / `Bug report:` prefix. */
  title: string;
  kind: ChangeRequestKind;
  /** What is being asked for. Never empty. */
  primaryRequest: string;
  subAspects: ChangeRequestSection[];
  context: ChangeRequestSection[];
  ignored: IgnoredFragment[];
}

type SectionClass = "primary" | "sub-aspect" | "context" | "metadata" | "list" | "unknown";

/** Headings that state the request itself. */
const PRIMARY_HEADINGS = new Set([
  "summary",
  "feature summary",
  "bug summary",
  "feature description",
  "feature request",
  "request",
  "the request",
  // GitHub's stock bug-report template: the description IS the report.
  "describe the bug",
]);

/** Headings that elaborate the request: what to build, or what should happen. */
const SUB_ASPECT_HEADINGS = new Set([
  "proposed solution",
  "suggested solution",
  "solution",
  "proposal",
  "expected behavior",
  "expected behaviour",
  "expected result",
  "expected results",
  "desired behavior",
  "desired behaviour",
  "implementation",
  "implementation notes",
  // GitHub's stock feature-request template.
  "describe the solution you'd like",
]);

/** Headings that explain the request without asking for anything further. */
const CONTEXT_HEADINGS = new Set([
  "problem",
  "problem statement",
  "what problem does this feature solve",
  "motivation",
  "why",
  "background",
  "context",
  "description",
  "steps to reproduce",
  "how to reproduce",
  "reproduction",
  "actual behavior",
  "actual behaviour",
  "current behavior",
  "current behaviour",
  "actual result",
  "actual results",
  "use case",
  "use cases",
  "additional context",
  "additional information",
  "alternatives considered",
  "alternatives",
  "logs",
  "relevant log output",
  "screenshots",
  // GitHub's stock templates.
  "to reproduce",
  "is your feature request related to a problem? please describe",
  "describe alternatives you've considered",
]);

/**
 * Context that describes what the reporter does NOT want. Shown, and left out of
 * the retrieval query: "a tool called `miniflux-sanity` can do this" must not
 * seed the search for code to edit.
 */
const NON_SEEDING_CONTEXT = new Set([
  "alternatives considered",
  "alternatives",
  "describe alternatives you've considered",
]);

/** Template fields that describe the reporter's setup. */
const ENVIRONMENT_HEADINGS = new Set([
  "browser",
  "environment",
  "operating system",
  "os",
  "platform",
  "device",
  "checklist",
  "code of conduct",
  // GitHub's stock bug-report template.
  "desktop (please complete the following information)",
  "smartphone (please complete the following information)",
]);

/**
 * Headings that introduce a LIST of requirements. One of these means the text is
 * a requirements document that happens to have a "Problem" section, and the
 * splitter is the right reader for it.
 */
const LIST_HEADINGS = new Set([
  "requirements",
  "functional requirements",
  "non-functional requirements",
  "user stories",
  "stories",
  "features",
  "changes",
  "change list",
  "scope",
]);

/** Fewest recognised headings for a paste to read as an issue. One is not a form. */
const MIN_RECOGNISED_HEADINGS = 2;

const HEADING_LINE = /^\s*(#{1,6})\s+(.*\S)\s*$/;
/**
 * A whole line in bold — `**Describe the bug**` — which is how GitHub's stock
 * MARKDOWN issue templates (as opposed to issue forms) mark a section. It only
 * ever OPENS a section when its label is in the template vocabulary (see
 * {@link splitSections}): a bold line in ordinary prose stays prose.
 *
 * Matched against the line with its trailing whitespace already removed
 * ({@link boldHeadingLabel}). The pattern used to end in `\s*:?\s*$`: two
 * adjacent unbounded runs, so `**a**` + 200 KB of spaces + `x` was tried at
 * every split point and took 23 s (PR #1090 review 2).
 */
const BOLD_HEADING_LINE = /^\s{0,8}(?:\*\*|__)([^*_\n]{1,120})(?:\*\*|__)\s{0,8}:?$/;

/** The label of a whole-line bold heading; null when the line is not one. */
function boldHeadingLabel(line: string): string | null {
  return line.trimEnd().match(BOLD_HEADING_LINE)?.[1] ?? null;
}
/** The level a bold-line heading is given: below a `#` title, like a form's `###`. */
const BOLD_HEADING_LEVEL = 3;
const FENCE_LINE = /^\s*(```|~~~)/;
const PLACEHOLDER_LINE = /^_?(no response|n\/a|none|not applicable)_?\.?$/i;
const BARE_URL_LINE = /^<?https?:\/\/\S+>?$/i;
const VERSION_LINE = /^v?\d+(\.\d+){1,3}([-+][\w.]+)?$/i;
/** "Thank you for Miniflux!" — a whole line, and not "Thanks to X, ...". */
const SIGN_OFF_LINE =
  /^(thanks|thank you|many thanks|thx|cheers|best regards|kind regards|regards)\b(?!\s+to\b)[^.?]{0,60}[.!]*$/i;
/** `[Feature]:` / `[Bug]` / `Feature request:` / `Bug report:` in front of a title. */
const TITLE_TAG =
  /^\s*(?:\[([^\]]{1,40})\]\s*:?|((?:feature|bug)(?:\s+(?:request|report))?)\s*:)\s*/i;

const TITLE_MAX = 120;

interface RawSection {
  level: number;
  heading: string;
  lines: string[];
}

/** Longest heading compared against the vocabulary; no template label is near it. */
const HEADING_LABEL_MAX = 160;

/**
 * Fold a heading to its comparable form: no emphasis, no trailing punctuation,
 * straight apostrophes. Trailing characters are trimmed by index rather than by
 * a `[?:.!]+\s*$` pattern, which is quadratic on a long run of punctuation.
 */
function normalizeHeading(heading: string): string {
  const flat = heading
    .slice(0, HEADING_LABEL_MAX)
    .replace(/[*_`]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  let end = flat.length;
  while (end > 0 && "?:.! ".includes(flat[end - 1]!)) end--;
  return flat.slice(0, end);
}

function classifyHeading(heading: string): SectionClass {
  const label = normalizeHeading(heading);
  if (PRIMARY_HEADINGS.has(label)) return "primary";
  if (SUB_ASPECT_HEADINGS.has(label)) return "sub-aspect";
  if (CONTEXT_HEADINGS.has(label)) return "context";
  if (ENVIRONMENT_HEADINGS.has(label) || /(^|\s)version$/.test(label)) return "metadata";
  if (LIST_HEADINGS.has(label)) return "list";
  return "unknown";
}

/**
 * Split into the text before the first heading and the headed sections.
 *
 * `unknownBoldLabels` counts the whole-line bold labels OUTSIDE the template
 * vocabulary. They open no section — `**Note**` stays prose in the section it is
 * in — but they are counted like an unknown `#` heading, so a requirements
 * document marked up in bold (`**Background**`, `**Context**`, `**REQ-1 Export**`,
 * …) is not read as one issue (PR #1090 review 2).
 *
 * `boldSections` counts the sections a bold line OPENED. It says whether bold is
 * this document's section markup at all: in an issue form whose sections are
 * `###` headings, `**Note**` and `**Edit**` are emphasis, and three of them must
 * not outvote three template headings (PR #1090 review 3).
 */
function splitSections(text: string): {
  preamble: string[];
  sections: RawSection[];
  unknownBoldLabels: number;
  boldSections: number;
} {
  const preamble: string[] = [];
  const sections: RawSection[] = [];
  let unknownBoldLabels = 0;
  let boldSections = 0;
  let inFence = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE_LINE.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(HEADING_LINE);
    const bold = inFence || heading ? null : boldHeadingLabel(line);
    if (heading) {
      sections.push({ level: heading[1]!.length, heading: heading[2]!.trim(), lines: [] });
      continue;
    }
    if (bold !== null && classifyHeading(bold) !== "unknown") {
      sections.push({ level: BOLD_HEADING_LEVEL, heading: bold.trim(), lines: [] });
      boldSections++;
      continue;
    }
    if (bold !== null) unknownBoldLabels++;
    if (sections.length > 0) sections[sections.length - 1]!.lines.push(line);
    else preamble.push(line);
  }
  return { preamble, sections, unknownBoldLabels, boldSections };
}

/** Why a single line carries no request; null when it is content. */
function noiseReason(line: string): IgnoredReason | null {
  const t = line.trim();
  if (PLACEHOLDER_LINE.test(t)) return "placeholder";
  if (BARE_URL_LINE.test(t)) return "url";
  if (VERSION_LINE.test(t)) return "version";
  if (SIGN_OFF_LINE.test(t)) return "sign-off";
  return null;
}

/**
 * The section's content with noise lines moved to `ignored`. Lines inside a code
 * fence are content whatever they look like.
 */
function cleanLines(heading: string, lines: string[], ignored: IgnoredFragment[]): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_LINE.test(line)) inFence = !inFence;
    const reason = inFence || line.trim() === "" ? null : noiseReason(line);
    if (reason) ignored.push({ heading, text: line.trim(), reason });
    else kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTitleTag(raw: string): { title: string; kind: ChangeRequestKind } {
  const match = raw.match(TITLE_TAG);
  if (!match) return { title: raw.trim(), kind: "unknown" };
  const tag = (match[1] ?? match[2] ?? "").toLowerCase();
  const kind: ChangeRequestKind = tag.includes("bug")
    ? "bug"
    : tag.includes("feature")
      ? "feature"
      : "unknown";
  return { title: raw.slice(match[0].length).trim(), kind };
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](?:\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/** Same words, ignoring case, spacing and punctuation. */
function sameText(a: string, b: string): boolean {
  const fold = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return fold(a) === fold(b);
}

/**
 * Parse `text` as one issue. Returns null when it is not recognisably one: fewer
 * than {@link MIN_RECOGNISED_HEADINGS} template headings, no more template
 * headings than unknown ones (unknown whole-line bold labels included, in a
 * document that marks its sections in bold), more than one top-level title, or
 * a heading that introduces a requirement list.
 */
export function parseChangeRequest(text: string | null | undefined): ChangeRequest | null {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return null;

  const { preamble, sections, unknownBoldLabels, boldSections } = splitSections(trimmed);
  if (sections.filter((s) => s.level === 1).length > 1) return null;

  // A leading `# Title` is the title, not a section.
  const titled = preamble.every((l) => l.trim() === "") && sections[0]?.level === 1;
  const body = titled ? sections.slice(1) : sections;
  const classes = body.map((s) => classifyHeading(s.heading));
  if (classes.includes("list")) return null;
  const recognised = classes.filter((c) => c !== "unknown").length;
  if (recognised < MIN_RECOGNISED_HEADINGS) return null;
  // A document with a "Background" and a "Problem" section and then one section
  // per requirement is still a requirements document: template headings have to
  // outnumber the ones this parser does not know — `#` headings, and whole-line
  // bold labels where bold is how this document marks a section (it opened at
  // least one template section). Where every section is a `#` heading, a bold
  // line is a remark in its section and is not counted.
  const unknownBold = boldSections > 0 ? unknownBoldLabels : 0;
  if (classes.length - recognised + unknownBold >= recognised) return null;

  const ignored: IgnoredFragment[] = [];
  const preambleLines = titled ? sections[0]!.lines : preamble;
  const firstLine = preambleLines.findIndex((l) => l.trim() !== "");
  const rawTitle = titled
    ? sections[0]!.heading
    : firstLine === -1
      ? ""
      : preambleLines[firstLine]!;
  const lead = cleanLines(
    "",
    titled ? preambleLines : preambleLines.slice(firstLine === -1 ? 0 : firstLine + 1),
    ignored,
  );

  const primaryParts: string[] = [];
  const subAspects: ChangeRequestSection[] = [];
  const context: ChangeRequestSection[] = [];
  body.forEach((section, i) => {
    const cls = classes[i]!;
    if (cls === "metadata") {
      const reason: IgnoredReason = /version$/.test(normalizeHeading(section.heading))
        ? "version"
        : "environment";
      for (const line of section.lines) {
        if (line.trim() !== "")
          ignored.push({ heading: section.heading, text: line.trim(), reason });
      }
      return;
    }
    const cleaned = cleanLines(section.heading, section.lines, ignored);
    if (cleaned.length === 0) return;
    if (cls === "primary") primaryParts.push(cleaned);
    else if (cls === "context") context.push({ heading: section.heading, text: cleaned });
    // An unrecognised heading inside an issue elaborates the request.
    else subAspects.push({ heading: section.heading, text: cleaned });
  });

  const tagged = stripTitleTag(rawTitle);
  const summary = [lead, ...primaryParts].filter((p) => p.length > 0);
  const title =
    tagged.title || firstSentence(summary[0] ?? subAspects[0]?.text ?? context[0]?.text ?? "");
  if (title.length === 0) return null;
  // A summary that only restates the title adds nothing.
  const extra = summary.filter((p) => !sameText(p, title));
  const primaryRequest = [title, ...extra].join("\n\n");

  const bugShaped = body.some((s) =>
    /^(steps to reproduce|how to reproduce|to reproduce|actual behaviou?r|bug summary|describe the bug)$/.test(
      normalizeHeading(s.heading),
    ),
  );
  const kind: ChangeRequestKind =
    tagged.kind !== "unknown" ? tagged.kind : bugShaped ? "bug" : "feature";

  return { title, kind, primaryRequest, subAspects, context, ignored };
}

/** `Heading:` — or the heading as written when it already ends in a question mark. */
function sectionLabel(heading: string): string {
  const label = heading.replace(/:\s*$/, "").trim();
  return label.endsWith("?") ? label : `${label}:`;
}

/**
 * The request as one plain-text body: the primary request, then each sub-aspect
 * and each piece of context under its own heading. This is the text every later
 * stage reads, so nothing that was ignored is in it.
 */
export function renderRequestBody(request: ChangeRequest): string {
  return [
    request.primaryRequest,
    ...[...request.subAspects, ...request.context].map(
      (s) => `${sectionLabel(s.heading)}\n${s.text}`,
    ),
  ].join("\n\n");
}

/**
 * One section as search text: no code fences (JSON keys and SQL, not names of
 * code to find), no inline links, whitespace collapsed.
 */
function retrievalPart(part: string): string {
  return (
    part
      .replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")
      // Bounded on both sides, and a label holds no `[`: unbounded, `[^\]]+` and
      // `[^)]*` are quadratic on a long run of `[` or of unclosed `[a](http://…`
      // (text is accepted up to 500,000 characters). A link longer than the
      // bound is left to the URL pattern below.
      .replace(/\[([^[\]\n]{1,300})\]\(\s{0,8}https?:\/\/[^)\s]{0,500}\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * A section is cut to this many times the caller's limit BEFORE it is cleaned.
 * Cleaning only ever shortens, so the head of a section is all a capped caller
 * can use; the factor leaves room for what cleaning removes from that head.
 */
export const RETRIEVAL_PART_HEADROOM = 4;

/**
 * The text to search code with: the request, its sub-aspects and its context,
 * without the alternatives the reporter rejected, code fences or inline links.
 *
 * `maxChars` is for a caller that will keep only the first `maxChars` characters
 * of the result (`seedQueries`, which caps its query). With it the work is
 * bounded by that limit, not by the request: each section is cut to
 * `maxChars × RETRIEVAL_PART_HEADROOM` before the replace chain, and sections
 * stop being read once the text is already longer than `maxChars`. Without it
 * the whole request went through the chain — up to 500,000 characters, twice
 * over for the worst input — to produce a query that was then cut to 4,000
 * (PR #1090 review 3).
 *
 * The result is IDENTICAL to the uncapped one whenever no section is longer
 * than `maxChars × RETRIEVAL_PART_HEADROOM` and the uncapped text is no longer
 * than `maxChars`; and when no section is over that length, its first
 * `maxChars` characters are identical whatever the total (stopping early drops
 * only text past the limit). A longer section is cleaned from its head alone,
 * so a fence or link that spans the cut is treated as unclosed.
 */
export function requestRetrievalText(
  request: ChangeRequest,
  options: { maxChars?: number } = {},
): string {
  const { maxChars } = options;
  const parts = [
    request.primaryRequest,
    ...request.subAspects.map((s) => s.text),
    ...request.context
      .filter((s) => !NON_SEEDING_CONTEXT.has(normalizeHeading(s.heading)))
      .map((s) => s.text),
  ];
  if (maxChars === undefined) {
    return parts
      .map(retrievalPart)
      .filter((p) => p.length > 0)
      .join("\n\n");
  }
  const partLimit = maxChars * RETRIEVAL_PART_HEADROOM;
  const cleaned: string[] = [];
  let length = 0;
  for (const part of parts) {
    const text = retrievalPart(part.length > partLimit ? part.slice(0, partLimit) : part);
    if (text.length === 0) continue;
    length += text.length + (cleaned.length > 0 ? 2 : 0);
    cleaned.push(text);
    if (length > maxChars) break;
  }
  return cleaned.join("\n\n");
}

// ── What the request ASKS, as opposed to what it says around it (#791) ───────

/** What the #791 gate and the `ALTER TABLE` fast path read of one change. */
export interface RequestGateText {
  /**
   * What is being asked for: the primary request and its sub-aspects. No context
   * section — the problem statement, the steps to reproduce, the alternatives the
   * reporter rejected and the logs describe; they do not ask.
   */
  ask: string;
}

/**
 * {@link RequestGateText} for a change. A change the splitter produced has no
 * sections: it is one requirement, so all of it is the ask.
 */
export function requestGateText(
  change: Pick<ChangedRequirement, "title" | "body" | "request">,
): RequestGateText {
  const request = change.request;
  if (!request) return { ask: `${change.title}\n${change.body}` };
  return { ask: [request.primaryRequest, ...request.subAspects.map((s) => s.text)].join("\n\n") };
}

const REMOVED_RE =
  /\b(remov\w*|delet\w*|deprecat\w*|drop(?:ped|ping|s)?|retir\w*|discontinu\w*)\b/i;
const MODIFIED_RE = /\b(modif\w*|chang\w*|renam\w*|replac\w*|instead of)\b/i;

/** A bug fix modifies what exists; a feature is typed by the verb of its request. */
function requestChangeType(request: ChangeRequest): ChangeType {
  if (request.kind === "bug") return "modified";
  if (REMOVED_RE.test(request.primaryRequest)) return "removed";
  if (MODIFIED_RE.test(request.primaryRequest)) return "modified";
  return "added";
}

/** The single {@link ChangedRequirement} an issue becomes. */
export function changeFromRequest(request: ChangeRequest): ChangedRequirement {
  const body = renderRequestBody(request);
  const title =
    request.title.length > TITLE_MAX
      ? `${request.title.slice(0, TITLE_MAX - 3)}...`
      : request.title;
  return {
    requirementId: null,
    title,
    body,
    changeType: requestChangeType(request),
    bodyDelta: body.length,
    request,
  };
}

/**
 * The extractor's pure core: one change for an issue, today's splitter for
 * everything else. Synchronous so a serializer can re-run it without an await.
 */
export function extractChangesByShape(text: string): ChangedRequirement[] {
  const request = parseChangeRequest(text);
  return request ? [changeFromRequest(request)] : extractChangesHeuristically(text);
}

/** The extractor the impact engine is wired with by default (#1036). */
export const shapeAwareChangeExtractor: ChangeExtractor = {
  async extract(text: string): Promise<ChangedRequirement[]> {
    return extractChangesByShape(text);
  },
};
