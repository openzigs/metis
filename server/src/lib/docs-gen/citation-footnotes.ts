/**
 * #737 — render the grounding ids the model cites as working, readable,
 * document-scoped footnotes.
 *
 * Phase 2 is told to cite the `id` of each grounding source inline
 * (`[facts:…]`, `[rag:…]`, `[web:…]`). Those ids are internal: a repository
 * module id is a URL-encoded JSON tuple (#1354), so #1360 stripped every marker
 * at assembly. The reader then got no citations at all — or, where the model
 * wrapped markers in parentheses, empty `(,,,)` — and the model compensated by
 * writing its own per-section "source key" tables of raw ids whose handles
 * (`S1`, `[^storage]`) meant different modules in different sections.
 *
 * This runs at ASSEMBLY, after claim extraction and judging (so grounding is
 * scored on what the model wrote) and over the WHOLE document, so:
 *   - every marker becomes a GFM footnote reference, numbered once for the
 *     document — a module cited from two sections is one footnote, however its
 *     per-section rank-suffixed id differs (`facts:…:0` vs `facts:…:3`);
 *   - each definition names the source a reader can open: the module path, or
 *     `file:start-end` for a typed-symbol source;
 *   - a module-facts citation is pinned to the `file:line` in that module's
 *     facts (a mined rule's locator, #155) whose line its sentence restates,
 *     when one matches well enough ({@link pinnedLocator}); otherwise it stays
 *     the module path. Modules are cited far more than symbols, so without this
 *     a whole architecture document carried no `file:line` at all;
 *   - a parenthesised run of markers collapses to the references alone;
 *   - an id that matches no admitted source is dropped, as before;
 *   - a bare id the model copied into its own prose or key table is replaced by
 *     the readable reference, so no URL-encoded key reaches the reader.
 *
 * Pure: no I/O. Fenced code is never touched.
 */
import type { GroundingSource } from "./grounding/grounding-context.js";

/** A bracketed marker; unterminated at end of line when the model was cut off. */
const MARKER = String.raw`\[\s*(?:facts|rag|web):[^\]\n]*(?:\]|$)`;

/** An optional leading space, an optional `(`, a run of markers, an optional `)`. */
const CLUSTER_RE = new RegExp(
  String.raw`( ?)(\(\s*)?(${MARKER}(?:[\s,;]*${MARKER})*)(\s*\))?`,
  "g",
);
const MARKER_RE = new RegExp(MARKER, "g");

/** A bare id, optionally in backticks, that the model wrote outside a marker. */
const BARE_ID_RE = /`?\b((?:facts|rag|web):[^\s\])|`,;]+)`?/g;

/** Footnote label prefix, distinct from any footnote the model wrote itself. */
const LABEL_PREFIX = "src-";

/** `[connector, graph, path]` from a `repo:<encoded JSON>` identity, else null. */
function decodeRepositoryPath(identity: string): string | null {
  if (!identity.startsWith("repo:")) return null;
  try {
    const tuple: unknown = JSON.parse(decodeURIComponent(identity.slice("repo:".length)));
    if (Array.isArray(tuple) && typeof tuple[2] === "string" && tuple[2]) return tuple[2];
  } catch {
    // Not a repository identity — the caller falls back to the label.
  }
  return null;
}

/** Path and line range of a `facts:symbol:<enc identity>:<symbol>:<start>-<end>` id. */
function decodeSymbolLocation(sourceId: string): string | null {
  if (!sourceId.startsWith("facts:symbol:")) return null;
  const parts = sourceId.slice("facts:symbol:".length).split(":");
  if (parts.length < 3) return null;
  const range = parts[parts.length - 1];
  if (!/^\d+-\d+$/.test(range)) return null;
  let identity: string;
  try {
    identity = decodeURIComponent(parts.slice(0, -2).join(":"));
  } catch {
    return null;
  }
  const path = decodeRepositoryPath(identity) ?? (identity.startsWith("repo:") ? null : identity);
  if (!path) return null;
  const [start, end] = range.split("-");
  return start === end ? `${path}:${start}` : `${path}:${range}`;
}

/** Module path of a `facts:repo:<enc>:<idx>` id, else null. */
function decodeModulePath(sourceId: string): string | null {
  const m = /^facts:(repo:[^:]+):\d+$/.exec(sourceId);
  return m ? decodeRepositoryPath(m[1]) : null;
}

const code = (s: string): string => `\`${s.replace(/`/g, "")}\``;

/**
 * The id of a canonical fact (`canonicalSourceId`, `canonical-facts.ts`):
 * `cf-` and ten hex digits. The whole id, not the `facts:canon:` prefix: a
 * module in a top-level directory named `canon` has the legacy facts id
 * `facts:canon:<index>`, and it is module facts whatever the plan setting (#1119).
 */
const CANONICAL_FACT_ID = /^facts:canon:cf-[0-9a-f]{10}$/;

/** One `file:line` or `file:start-end` locator found in a source's text. */
export interface SourceLineLocator {
  filePath: string;
  startLine: number;
  endLine: number;
  /** `file:line` or `file:start-end`, as a reader sees it. */
  locator: string;
  /** The words of the text line the locator stands on, for matching a sentence to it. */
  words: ReadonlySet<string>;
}

/** A line the provenance manifest records for a cited source (#737). */
export interface CitedLine {
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * One whitespace-delimited token that is a whole locator. Anchored, and run on
 * one token at a time of at most {@link MAX_LOCATOR_TOKEN} characters that
 * holds a colon, so it stays linear: the facts text is model output that
 * repository content can steer.
 */
const LOCATOR_TOKEN_RE = /^([\w./-]+\.[A-Za-z0-9]+):(\d{1,7})(?:-(\d{1,7}))?$/;
const MAX_LOCATOR_TOKEN = 512;
/** Punctuation a locator is wrapped in: `(x.go:42)`, `` `x.go:42` ``, `x.go:42,`. */
const LOCATOR_LEAD_RE = /^[([{<`'"]+/;
const LOCATOR_TAIL_RE = /[)\]}>`'",;.:]+$/;

const STOP_WORDS = new Set(
  (
    "the and for are was were with that this from into its has have had not but all any can " +
    "each per one own than then when which who whom what where while will would may must " +
    "only also more most such via upon over under after before about there their them they " +
    "you your our out use used uses using get set new see"
  ).split(" "),
);

/** A light stem, so `entries`/`entry` and `purged`/`purge` meet. */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Marks a number among the words: it counts double, as a limit or a period names one rule. */
const NUMBER_PREFIX = "#";

/**
 * The words of `text`, identifiers split (`cleanupRemovedEntriesDays`,
 * `feed_url`) and stemmed, plus its numbers of two or more digits with any
 * thousands separators removed (`1,000` → `1000`). Linear.
 */
function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  for (const m of spaced.matchAll(/[A-Za-z]+|\d[\d,]*/g)) {
    const token = m[0];
    if (/^\d/.test(token)) {
      const n = token.replace(/,/g, "");
      if (n.length >= 2) out.add(`${NUMBER_PREFIX}${n}`);
      continue;
    }
    const w = token.toLowerCase();
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

/**
 * Every `path.ext:line` / `path.ext:start-end` locator in `text`, in order,
 * each with the words of the line it stands on. Only a whole
 * whitespace-delimited token (less any wrapping punctuation) counts.
 */
export function sourceLineLocators(text: string): SourceLineLocator[] {
  const out: SourceLineLocator[] = [];
  for (const line of text.split("\n")) {
    let words: Set<string> | undefined;
    for (const raw of line.split(/\s+/)) {
      if (raw.length > MAX_LOCATOR_TOKEN || !raw.includes(":")) continue;
      const m = LOCATOR_TOKEN_RE.exec(
        raw.replace(LOCATOR_LEAD_RE, "").replace(LOCATOR_TAIL_RE, ""),
      );
      if (!m) continue;
      const startLine = Number(m[2]);
      const endLine = m[3] ? Number(m[3]) : startLine;
      if (startLine < 1 || endLine < startLine) continue;
      words ??= wordsOf(line);
      out.push({
        filePath: m[1],
        startLine,
        endLine,
        locator: endLine === startLine ? `${m[1]}:${startLine}` : `${m[1]}:${startLine}-${endLine}`,
        words,
      });
    }
  }
  return out;
}

/** The least overlap that pins a citation to a line: a number and a word, or three words. */
const PIN_MIN_SCORE = 3;

/**
 * The locator whose line `sentence` restates best, or null when none shares
 * enough of its words ({@link PIN_MIN_SCORE}; a number counts two). Ties go to
 * the first in the text. Deterministic and pure.
 */
export function pinnedLocator(
  sentence: string,
  locators: readonly SourceLineLocator[],
): SourceLineLocator | null {
  if (locators.length === 0) return null;
  const words = wordsOf(sentence);
  let best: SourceLineLocator | null = null;
  let bestScore = PIN_MIN_SCORE - 1;
  for (const locator of locators) {
    let score = 0;
    for (const w of words) if (locator.words.has(w)) score += w.startsWith(NUMBER_PREFIX) ? 2 : 1;
    if (score > bestScore) {
      best = locator;
      bestScore = score;
    }
  }
  return best;
}

/** A module-facts source: not a canonical fact and not a typed symbol. */
function isModuleFacts(source: GroundingSource): boolean {
  return (
    source.kind === "facts" &&
    !CANONICAL_FACT_ID.test(source.sourceId) &&
    decodeSymbolLocation(source.sourceId) === null
  );
}

/** A module-facts reference pinned to one of its lines. */
function pinnedReference(source: GroundingSource, locator: SourceLineLocator): string {
  const module = decodeModulePath(source.sourceId) ?? source.label;
  return `${code(locator.locator)} — ${code(module)} (module facts)`;
}

/** The line range a typed-symbol id names, for the manifest. */
function symbolLines(sourceId: string): CitedLine | null {
  const location = decodeSymbolLocation(sourceId);
  const m = location ? /^(.+):(\d+)(?:-(\d+))?$/.exec(location) : null;
  if (!m) return null;
  const startLine = Number(m[2]);
  return { filePath: m[1], startLine, endLine: m[3] ? Number(m[3]) : startLine };
}

/**
 * The sentence a marker at `offset` of `line` cites: the text before it, other
 * markers removed, from the last sentence end or table-cell border. A marker
 * that stands after its sentence's full stop cites that sentence.
 */
function sentenceBefore(line: string, offset: number): string {
  const pieces = line
    .slice(0, offset)
    .replace(MARKER_RE, " ")
    .split(/(?<=[.!?])\s+|\|/);
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (pieces[i].trim()) return pieces[i];
  }
  return "";
}

/** The reference a reader can follow for one admitted grounding source. */
export function readableSourceReference(source: GroundingSource): string {
  if (source.kind === "facts") {
    // #1070 — a canonical fact: its label is the source line and the value.
    if (CANONICAL_FACT_ID.test(source.sourceId)) {
      return `${code(source.label)} (canonical fact, read from the source)`;
    }
    const location = decodeSymbolLocation(source.sourceId);
    if (location) return `${code(location)} — ${code(source.label)}`;
    return `${code(decodeModulePath(source.sourceId) ?? source.label)} (module facts)`;
  }
  if (source.kind === "rag") return `${code(source.label)} (retrieved excerpt)`;
  return `${code(source.label.replace(/^web:/, ""))} (web research)`;
}

/** The readable form of a bare id, from the admitted sources or the id itself. */
function readableBareId(id: string, byId: ReadonlyMap<string, GroundingSource>): string | null {
  const source = byId.get(id);
  if (source) return readableSourceReference(source);
  const location = decodeSymbolLocation(id) ?? decodeModulePath(id);
  return location ? code(location) : null;
}

/**
 * Rewrite every marker cluster outside fenced code as the references
 * `referenceFor` gives its ids (each distinct reference once; an id it returns
 * null for is dropped), and every bare id as its readable form.
 */
function rewriteMarkers(
  markdown: string,
  byId: ReadonlyMap<string, GroundingSource>,
  referenceFor: (id: string, sentence: () => string) => string | null,
): string {
  const renderCluster = (
    _match: string,
    lead: string,
    open: string | undefined,
    inner: string,
    close: string | undefined,
    offset: number,
    line: string,
  ): string => {
    const references: string[] = [];
    let cited: string | undefined;
    const sentence = (): string => (cited ??= sentenceBefore(line, offset));
    for (const marker of inner.match(MARKER_RE) ?? []) {
      const body = marker.replace(/^\[\s*/, "").replace(/\]$/, "");
      for (const token of body.split(/[,;\s]+/)) {
        if (!/^(?:facts|rag|web):/.test(token)) continue;
        const reference = referenceFor(token, sentence);
        if (reference !== null && !references.includes(reference)) references.push(reference);
      }
    }
    const refs = references.join("");
    // A bracket pair the cluster owns is dropped with it; an unmatched one
    // belongs to the surrounding prose and is kept.
    if (open && !close) return `${lead}(${refs}`;
    if (close && !open) return `${refs})`;
    return refs;
  };

  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replace(CLUSTER_RE, renderCluster)
        .replace(BARE_ID_RE, (match, id: string) => readableBareId(id, byId) ?? match);
    })
    .join("\n");
}

/** The rewritten body and the footnote definitions it references, in order. */
function renderParts(
  markdown: string,
  sources: Iterable<GroundingSource>,
): { body: string; definitions: string[]; citedLines: Map<string, CitedLine[]> } {
  const byId = new Map<string, GroundingSource>();
  for (const s of sources) if (!byId.has(s.sourceId)) byId.set(s.sourceId, s);
  // A module's locators, read once per source however often it is cited.
  const locatorsOf = new Map<string, SourceLineLocator[]>();
  const citedLines = new Map<string, CitedLine[]>();
  const recordLine = (sourceId: string, line: CitedLine): void => {
    const lines = citedLines.get(sourceId) ?? [];
    const seen = lines.some(
      (l) =>
        l.filePath === line.filePath &&
        l.startLine === line.startLine &&
        l.endLine === line.endLine,
    );
    if (!seen) lines.push(line);
    citedLines.set(sourceId, lines);
  };

  // One number per distinct READABLE reference, in order of first citation.
  const numberOf = new Map<string, number>();
  const definitions: string[] = [];
  const body = rewriteMarkers(markdown, byId, (id, sentence) => {
    const source = byId.get(id);
    if (!source) return null;
    let reference = readableSourceReference(source);
    if (isModuleFacts(source)) {
      let locators = locatorsOf.get(id);
      if (!locators) {
        locators = sourceLineLocators(source.text);
        locatorsOf.set(id, locators);
      }
      const pin = pinnedLocator(sentence(), locators);
      if (pin) {
        reference = pinnedReference(source, pin);
        recordLine(id, { filePath: pin.filePath, startLine: pin.startLine, endLine: pin.endLine });
      }
    } else {
      const lines = symbolLines(id);
      if (lines) recordLine(id, lines);
    }
    let n = numberOf.get(reference);
    if (n === undefined) {
      n = numberOf.size + 1;
      numberOf.set(reference, n);
      definitions.push(`[^${LABEL_PREFIX}${n}]: ${reference}`);
    }
    return `[^${LABEL_PREFIX}${n}]`;
  });
  return { body, definitions, citedLines };
}

/**
 * Replace the cited grounding ids in an assembled document with document-scoped
 * footnotes, and append their definitions. `sources` is every source admitted
 * to any section of the run; ids outside it are dropped.
 */
export function renderCitationFootnotes(
  markdown: string,
  sources: Iterable<GroundingSource>,
): string {
  return renderCitationFootnotesWithLocations(markdown, sources).markdown;
}

/**
 * {@link renderCitationFootnotes}, plus the source lines its footnotes name,
 * per cited source id, in order of first citation: a typed symbol's range and
 * each line a module-facts citation was pinned to. A source cited only at
 * module level has no entry. The provenance manifest records these (#737).
 */
export function renderCitationFootnotesWithLocations(
  markdown: string,
  sources: Iterable<GroundingSource>,
): { markdown: string; citedLines: Map<string, CitedLine[]> } {
  const { body, definitions, citedLines } = renderParts(markdown, sources);
  return {
    markdown: definitions.length > 0 ? `${body}\n\n${definitions.join("\n")}` : body,
    citedLines,
  };
}

/** Digits a footnote number is counted at by {@link renderedCitationLength}. */
const COUNTED_FOOTNOTE_DIGITS = 4;

/**
 * #995 — how long `markdown` will be once {@link renderCitationFootnotes} has
 * rewritten its markers, without the definitions appended at the end. A drafted
 * marker (`[facts:repo:%5B%22…%22%5D:1]`, ~110 characters) renders as a short
 * `[^src-N]`, so a length cap measured on the draft cuts a citation-heavy
 * section to a fraction of its budget.
 *
 * Section by section, before the document's sources and numbering are known, so
 * it errs long: every cited id counts as its own reference (rendering may drop
 * an unadmitted one, or merge two that name one module) at a four-digit number.
 */
export function renderedCitationLength(markdown: string): number {
  const index = new Map<string, number>();
  return rewriteMarkers(markdown, new Map(), (id) => {
    let n = index.get(id);
    if (n === undefined) {
      n = index.size;
      index.set(id, n);
    }
    return `[^${LABEL_PREFIX}${String(n).padStart(COUNTED_FOOTNOTE_DIGITS, "0")}]`;
  }).length;
}

/**
 * #995 — the characters {@link renderCitationFootnotes} appends to `markdown`
 * for its footnote definitions (0 when it cites nothing). Trimming text only
 * removes citations, so the value for a draft bounds the value for any fit of it.
 */
export function citationDefinitionsLength(
  markdown: string,
  sources: Iterable<GroundingSource>,
): number {
  const { definitions } = renderParts(markdown, sources);
  return definitions.length > 0 ? 2 + definitions.join("\n").length : 0;
}
