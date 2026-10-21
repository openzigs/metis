/**
 * #1114 — neutralise text that LOOKS like a `===METIS-DATA-BOUNDARY===` fence.
 *
 * Every analysis prompt, and every tool result the agent loop shows a model, puts
 * untrusted text between `===METIS-DATA-BOUNDARY===` fences. Redacting only the
 * byte-exact fence (and its ASCII case/spacing variants) left a hole: full-width
 * equals signs, a zero-width or bidi character inside the label, hyphen
 * look-alikes, Cyrillic/Greek homoglyphs, small capitals... are not the fence,
 * but a model reading them can take them for one and treat what follows as
 * instructions.
 *
 * How it works, without changing any text that is not fence-shaped:
 *
 *   1. Build a COMPARISON copy, one code point at a time (`foldCodePoint`):
 *      a. a code point in `CONFUSABLES` maps straight to its fence character;
 *      b. otherwise drop it if it is a format, default-ignorable or combining
 *         character (zero-width, bidi controls, soft hyphen, tag characters,
 *         variation selectors);
 *      c. otherwise decompose it (NFKD), drop the combining parts, and for each
 *         part: `CONFUSABLES` again, else upper-case it, decompose the result
 *         again and map EVERY resulting unit through `CONFUSABLES` once more.
 *         Case first, then confusables: lower-case Greek/Cyrillic letters only
 *         reach a confusable once upper-cased (`м` → `М`).
 *      HTML character references (`&#61;`, `&#x3D;`, `&equals;` and a few
 *      named dashes and spaces) fold as the character they encode.
 *   2. Find fence-shaped spans in that copy with one FIXED pattern (`FOLDED_FENCE`).
 *   3. Replace the matching spans IN THE ORIGINAL. Everything else is returned
 *      byte-for-byte, so full-width CJK text, ligatures, superscripts and RTL text
 *      away from a fence are untouched and quoted snippets still match their
 *      chunk. Text with no fence-shaped span is returned as the same string, and
 *      the offset map is only built when there is a match.
 *
 * A match that starts or ends inside one code point's expansion is widened to
 * the whole code point. The replacement MUST therefore contain no `=` and no
 * label text — otherwise the widened-away prefix plus the replacement can
 * re-form a fence (#1350 review: U+2A74 folds to `::=`). Both callers use
 * `[REDACTED-FENCE]`.
 *
 * Linear in the length of the text: one pass to fold, one regex pass that cannot
 * backtrack across a run, and, only on a match, one pass to map and splice.
 *
 * Dependency-free (apart from the generated table) so both
 * `analysis/prompts.ts` and `tool-runtime/fence.ts` can use it.
 */
import { CONFUSABLE_SOURCES } from "./fence-confusables.generated.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Hand-added, because Unicode `confusables.txt` does not list them and NFKD does
 * not decompose them, yet a model reads each as the letter:
 *  - small capitals for the label's letters (`ᴍᴇᴛɪꜱ`);
 *  - negative circled, negative squared and regional-indicator letters
 *    (U+1F150, U+1F170, U+1F1E6 blocks; the plain circled and squared forms
 *    already decompose under NFKD).
 */
const SMALL_CAPITALS: ReadonlyArray<readonly [number, string]> = [
  [0x1d00, "A"],
  [0x0299, "B"],
  [0x1d05, "D"],
  [0x1d07, "E"],
  [0x026a, "I"],
  [0x1d0d, "M"],
  [0x0274, "N"],
  [0x1d0f, "O"],
  [0x0280, "R"],
  [0xa731, "S"],
  [0x1d1b, "T"],
  [0x1d1c, "U"],
  [0x028f, "Y"],
];
const ENCLOSED_LETTER_BLOCKS = [0x1f150, 0x1f170, 0x1f1e6];
/**
 * `l` is the confusables PROTOTYPE of `I` (the table maps `I`, `1`, `|`... to
 * it), so it is not itself a source row; it reads as `I` all the same.
 */
const PROTOTYPES: ReadonlyArray<readonly [number, string]> = [[0x6c, "I"]];

/** Read as `=`: double horizontal bar, identical-to, geta mark. */
const EXTRA_EQUALS = [0x2550, 0x2261, 0x3013];
/** Read as `-`: em dash, horizontal bar, box-drawing bars, two- and three-em dashes. */
const EXTRA_DASHES = [0x2014, 0x2015, 0x2500, 0x2501, 0x2e3a, 0x2e3b];
/**
 * Read as a separator INSIDE the label (folded to `-`, which the pattern treats
 * as one): full stop, middle dot, katakana prolonged sound mark, Hebrew maqaf,
 * braille blank, and backslash — so a Markdown-escaped `\=\=\=` folds to
 * `-=-=-=` and still ends in a run of `=` next to the label.
 */
const EXTRA_SEPARATORS = [0x2e, 0xb7, 0x30fc, 0x05be, 0x2800, 0x5c];

/** Code point → its fence character. Generated confusables first; hand-added entries never override them. */
export const CONFUSABLES: ReadonlyMap<number, string> = (() => {
  const map = new Map<number, string>();
  for (const [to, from] of CONFUSABLE_SOURCES) for (const c of from) map.set(c, to);
  const extra: Array<readonly [number, string]> = [
    ...PROTOTYPES,
    ...SMALL_CAPITALS,
    ...ENCLOSED_LETTER_BLOCKS.flatMap((base) => [...LETTERS].map((l, i) => [base + i, l] as const)),
    ...EXTRA_EQUALS.map((c) => [c, "="] as const),
    ...EXTRA_DASHES.map((c) => [c, "-"] as const),
    ...EXTRA_SEPARATORS.map((c) => [c, "-"] as const),
  ];
  for (const [c, to] of extra) if (!map.has(c)) map.set(c, to);
  return map;
})();

/** Dropped from the comparison copy: invisible, formatting, or combining. */
const IGNORABLE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]$/u;

/**
 * Label: the letters of METIS DATA BOUNDARY with any whitespace, `-` or `_`
 * between them (`S`). A fence-shaped span in the comparison copy is either
 *
 *   A. a run of `=`, the label, then any chain of (`=` run, label), then an
 *      optional `=` run — so `===LABEL===`, the chain `===LABEL===LABEL===`
 *      (one span, never leaving `LABEL===` behind) and the one-sided
 *      `===LABEL`; or
 *   B. the label, any chain of (`=` run, label), then a `=` run — the one-sided
 *      `LABEL===`.
 *
 * The bare label with no `=` beside it is left alone: every real fence carries
 * `=` runs, and the words alone occur in ordinary text about METIS.
 *
 * `(?<!=)` makes A start only at the FIRST `=` of a run; without it a long run
 * of `=` is re-scanned from every position (the pre-#1114 pattern took
 * quadratic time on 200 KB of `=`). B starts only at an `M`, and each attempt
 * scans no further than the next character that cannot continue the label.
 */
const FOLDED_FENCE =
  /(?<!=)=+[\s_-]*M[\s_-]*E[\s_-]*T[\s_-]*I[\s_-]*S[\s_-]*D[\s_-]*A[\s_-]*T[\s_-]*A[\s_-]*B[\s_-]*O[\s_-]*U[\s_-]*N[\s_-]*D[\s_-]*A[\s_-]*R[\s_-]*Y(?:[\s_-]*=+[\s_-]*M[\s_-]*E[\s_-]*T[\s_-]*I[\s_-]*S[\s_-]*D[\s_-]*A[\s_-]*T[\s_-]*A[\s_-]*B[\s_-]*O[\s_-]*U[\s_-]*N[\s_-]*D[\s_-]*A[\s_-]*R[\s_-]*Y)*(?:[\s_-]*=+)?|M[\s_-]*E[\s_-]*T[\s_-]*I[\s_-]*S[\s_-]*D[\s_-]*A[\s_-]*T[\s_-]*A[\s_-]*B[\s_-]*O[\s_-]*U[\s_-]*N[\s_-]*D[\s_-]*A[\s_-]*R[\s_-]*Y(?:[\s_-]*=+[\s_-]*M[\s_-]*E[\s_-]*T[\s_-]*I[\s_-]*S[\s_-]*D[\s_-]*A[\s_-]*T[\s_-]*A[\s_-]*B[\s_-]*O[\s_-]*U[\s_-]*N[\s_-]*D[\s_-]*A[\s_-]*R[\s_-]*Y)*[\s_-]*=+/g;

/**
 * HTML character references, read as the character they encode. Bounded: at most
 * 7 decimal or 6 hex digits, so each `&` costs a constant amount of scanning.
 */
const CHAR_REF =
  /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|(equals|hyphen|dash|lowbar|UnderBar|nbsp|period|middot|bsol));/y;
const NAMED_REF: Readonly<Record<string, number>> = {
  equals: 0x3d,
  hyphen: 0x2010,
  dash: 0x2010,
  lowbar: 0x5f,
  UnderBar: 0x5f,
  nbsp: 0xa0,
  period: 0x2e,
  middot: 0xb7,
  bsol: 0x5c,
};

/** Text that folds unit for unit: ASCII without `&`. */
const ASCII_NO_REF = /^[\x00-\x25\x27-\x7f]*$/;

const foldMemo = new Map<number, string>();
export const FOLD_MEMO_LIMIT = 4096;

/** How many folds are memoised — for the test that the memo stays bounded. */
export function foldMemoSize(): number {
  return foldMemo.size;
}

/** Map one unit (already decomposed, not ignorable) through case and confusables. */
function foldUnit(part: string): string {
  const pcp = part.codePointAt(0) as number;
  const direct = CONFUSABLES.get(pcp);
  if (direct !== undefined) return direct;
  const upper = part.toUpperCase();
  if (upper === part) return part;
  let out = "";
  for (const u of upper.normalize("NFKD")) {
    if (IGNORABLE.test(u)) continue;
    out += CONFUSABLES.get(u.codePointAt(0) as number) ?? u;
  }
  return out;
}

/**
 * The comparison form of one code point (may be empty, or several units).
 * Exported for the closure test: no unit of any fold is itself a `CONFUSABLES` key.
 */
export function foldCodePoint(cp: number): string {
  const direct = CONFUSABLES.get(cp);
  if (direct !== undefined) return direct;
  if (cp < 0x80) return String.fromCharCode(cp).toUpperCase();
  const memo = foldMemo.get(cp);
  if (memo !== undefined) return memo;
  const ch = String.fromCodePoint(cp);
  let out = "";
  if (!IGNORABLE.test(ch)) {
    for (const part of ch.normalize("NFKD")) {
      if (!IGNORABLE.test(part)) out += foldUnit(part);
    }
  }
  if (foldMemo.size < FOLD_MEMO_LIMIT) foldMemo.set(cp, out);
  return out;
}

/** Decode an HTML character reference at `i`, or return null. */
function charRefAt(raw: string, i: number): { cp: number; width: number } | null {
  CHAR_REF.lastIndex = i;
  const m = CHAR_REF.exec(raw);
  if (!m) return null;
  const cp =
    m[1] !== undefined
      ? parseInt(m[1], 10)
      : m[2] !== undefined
        ? parseInt(m[2], 16)
        : NAMED_REF[m[3]];
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return { cp, width: m[0].length };
}

/**
 * Walk `raw` once, calling `emit(folded, start, end)` for each source unit:
 * a code point, or a whole character reference.
 */
function walk(raw: string, emit: (folded: string, start: number, end: number) => void): void {
  let i = 0;
  while (i < raw.length) {
    if (raw.charCodeAt(i) === 0x26) {
      const ref = charRefAt(raw, i);
      if (ref) {
        emit(foldCodePoint(ref.cp), i, i + ref.width);
        i += ref.width;
        continue;
      }
    }
    const cp = raw.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    emit(foldCodePoint(cp), i, i + width);
    i += width;
  }
}

/**
 * Replace every span of `raw` that reads as the data-boundary fence — exactly,
 * one-sided, chained, or through a Unicode look-alike — with `replacement`.
 * Returns `raw` itself when there is no such span.
 *
 * `replacement` must contain no `=` and no label text (see the module comment).
 */
export function scrubFenceLookalikes(raw: string, replacement: string): string {
  if (raw.length === 0) return raw;

  // ASCII text without `&` folds one unit to one unit, so match offsets ARE the
  // original offsets: no walk, no map.
  if (ASCII_NO_REF.test(raw)) {
    let folded = "";
    for (let i = 0; i < raw.length; i++) folded += foldCodePoint(raw.charCodeAt(i));
    if (!hasFence(folded)) return raw;
    return splice(
      raw,
      folded,
      (j) => j,
      (j) => j + 1,
      replacement,
    );
  }

  // Pass 1: the folded copy only. Most text has no fence, and then no offset
  // map is ever allocated.
  let folded = "";
  walk(raw, (f) => {
    folded += f;
  });
  if (!hasFence(folded)) return raw;

  // Pass 2 (a match exists): per folded unit, the original [start, end).
  const starts = new Int32Array(folded.length);
  const ends = new Int32Array(folded.length);
  let k = 0;
  walk(raw, (f, start, end) => {
    for (let n = 0; n < f.length; n++) {
      starts[k] = start;
      ends[k] = end;
      k++;
    }
  });
  return splice(
    raw,
    folded,
    (j) => starts[j],
    (j) => ends[j],
    replacement,
  );
}

function hasFence(folded: string): boolean {
  FOLDED_FENCE.lastIndex = 0;
  return FOLDED_FENCE.test(folded);
}

/** Replace each folded-copy match with `replacement`, at its ORIGINAL offsets. */
function splice(
  raw: string,
  folded: string,
  startOf: (j: number) => number,
  endOf: (j: number) => number,
  replacement: string,
): string {
  FOLDED_FENCE.lastIndex = 0;
  let out = "";
  let cursor = 0;
  for (let m = FOLDED_FENCE.exec(folded); m !== null; m = FOLDED_FENCE.exec(folded)) {
    // Widened to whole code points; never re-emit text already replaced.
    const from = Math.max(startOf(m.index), cursor);
    const to = Math.max(endOf(m.index + m[0].length - 1), from);
    out += raw.slice(cursor, from) + replacement;
    cursor = to;
  }
  return out + raw.slice(cursor);
}
