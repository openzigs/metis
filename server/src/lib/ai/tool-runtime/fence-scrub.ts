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
 * #1351 — `scrubRequirementFenceLookalikes` runs the same fold against a second
 * pattern, `FOLDED_REQUIREMENT_FENCE`, for the `<<<REQUIREMENT …>>> … <<<END
 * REQUIREMENT>>>` fence of the traceability and impact-analysis prompts.
 *
 * #1360 — two more siblings on the same fold: `scrubSectionFenceLookalikes`
 * for the `=== LABEL ===` / `=== END LABEL ===` fences of the absence check,
 * the support panel, the faithfulness judge, the RAGAS relevancy judge and the
 * docs-gen mined-rule inventories, and `scrubItemsFenceLookalikes` for the
 * impact run summary's short `END ITEMS` terminator.
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

/**
 * #1351 — read as angle brackets, for the `<<<END REQUIREMENT>>>` fence: the
 * guillemets, CJK, mathematical and double angle brackets (not in
 * `confusables.txt` as `<`/`>`) as ONE — they quote ordinary words, `«Requirement»`
 * — and the very-much signs as three. A multi-unit value is a run of fence
 * characters, so the closure property (every unit of a fold is final) holds.
 */
const EXTRA_ANGLES: ReadonlyArray<readonly [number, string]> = [
  [0x00ab, "<"],
  [0x00bb, ">"],
  [0x226a, "<"],
  [0x226b, ">"],
  [0x22d8, "<<<"],
  [0x22d9, ">>>"],
  [0x3008, "<"],
  [0x3009, ">"],
  [0x27e8, "<"],
  [0x27e9, ">"],
  [0x300a, "<"],
  [0x300b, ">"],
  [0x27ea, "<"],
  [0x27eb, ">"],
  // PR #1362 review: ornament, tortoise-shell-like and nested angle brackets.
  [0x2770, "<"],
  [0x2771, ">"],
  [0x276c, "<"],
  [0x276d, ">"],
  [0x29fc, "<"],
  [0x29fd, ">"],
  [0x2aa1, "<"],
  [0x2aa2, ">"],
  [0x2991, "<"],
  [0x2992, ">"],
  [0x2993, "<"],
  [0x2994, ">"],
];

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
    ...EXTRA_ANGLES,
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
 * #1351 — the traceability prompts' `<<<REQUIREMENT …>>> … <<<END REQUIREMENT>>>`
 * fence, in the same comparison copy. A fence-shaped span is
 *
 *   A. a run of THREE or more `<`, optional `/`, the label (`REQUIREMENT` or
 *      `END REQUIREMENT`), then an optional run of `>` — `<<<END REQUIREMENT>>>`,
 *      `<<<REQUIREMENT>>>`, the one-sided `<<<END REQUIREMENT`;
 *   A'. one or two `<`, optional `/`, then `END REQUIREMENT` — `<END REQUIREMENT>`,
 *      `<<END REQUIREMENT>>`, `</END REQUIREMENT>`;
 *   B. `END REQUIREMENT` then a run of two or more `>` — `END REQUIREMENT>>>`;
 *   C. any run of three or more `<` or `>` — so the fence's brackets cannot
 *      be forged around a label the patterns above do not know. Deliberately
 *      broad: a `>>>` REPL prompt in requirement text is redacted too.
 *
 * Only the TERMINATOR (`END REQUIREMENT`) is caught with fewer than three
 * brackets, so ordinary code and modelling text is left alone (PR #1362
 * review): `List<Requirement>`, `Map<String, List<Requirement>>`,
 * `Func<Requirement>>`, `<Requirement>`, the ReqIF closing tag `</Requirement>`,
 * the SysML stereotype `<<requirement>>`, `requirement >> design` and
 * `latency < requirement`.
 *
 * Double-angle quotation marks (`«»`, `《》`, `⟪⟫`, `≪≫`) fold to ONE bracket,
 * so `«Requirement»` is ordinary text and `««END REQUIREMENT»»` still a fence.
 *
 * The bare label is left alone: requirements talk about requirements. The
 * `(?<!<)` / `(?<!>)` guards start a match only at the first bracket of a run,
 * so a long run is not re-scanned from every position.
 */
const FOLDED_REQUIREMENT_FENCE =
  /(?<!<)<{3,}[\s_/-]*(?:E[\s_-]*N[\s_-]*D[\s_-]*)?R[\s_-]*E[\s_-]*Q[\s_-]*U[\s_-]*I[\s_-]*R[\s_-]*E[\s_-]*M[\s_-]*E[\s_-]*N[\s_-]*T(?:[\s_-]*>+)?|(?<!<)<{1,2}[\s_/-]*E[\s_-]*N[\s_-]*D[\s_-]*R[\s_-]*E[\s_-]*Q[\s_-]*U[\s_-]*I[\s_-]*R[\s_-]*E[\s_-]*M[\s_-]*E[\s_-]*N[\s_-]*T(?:[\s_-]*>+)?|E[\s_-]*N[\s_-]*D[\s_-]*R[\s_-]*E[\s_-]*Q[\s_-]*U[\s_-]*I[\s_-]*R[\s_-]*E[\s_-]*M[\s_-]*E[\s_-]*N[\s_-]*T[\s_-]*>{2,}|(?<!<)<{3,}|(?<!>)>{3,}/g;

/**
 * #1360 — the `=== LABEL ===` section fences of the verifier, judge and
 * docs-gen prompts (`=== FINDING … ===` / `=== END FINDING ===`,
 * `=== EVIDENCE … ===`, `=== SOURCE EVIDENCE … ===`, `=== CLAIMS … ===`,
 * `=== QUESTION … ===`, `=== ANSWER … ===`, `=== DETERMINISTICALLY-MINED …
 * RULE INVENTORY … ===` / `=== END … MINED RULES ===`, `… STEP PIPELINE`,
 * `… DATASET LINEAGE`, `DATA_LINEAGE`). Built from these constants once, at
 * load; every piece below is a literal.
 *
 * Unlike the data-boundary fence there is no unique token: the fence IS a
 * label between `=` runs, and `===` is also JavaScript's strict equality. So
 * a NOUN (one of the labels' head words) must be present, nothing spans a line
 * break, and every `=` run is at least two long. A span is
 *
 *   C.  a closing LINE: two or more `=`, then — at most 200 characters, none
 *       of them `=`, a line break or `& ; { } < > ! ? *` — a terminator word
 *       (`END`, `ENDS`, `CLOSE`, `CLOSING`…, not inside a word) and a noun in
 *       either order, then two or more `=`; and the span either starts its line
 *       (after spaces) or runs to its end. So `=== END: EVIDENCE ===`,
 *       `=== END (EVIDENCE) ===`, `=== END "FINDING" ===`,
 *       `=== EVIDENCE ENDS HERE ===`, `=== CLOSE EVIDENCE ===`,
 *       `// === CLOSE EVIDENCE ===` and `=== END OF ALL OF THE EVIDENCE … ===`.
 *       The line anchor is what keeps `status == CLOSED || claim == 0` out: a
 *       `==` between two operands neither starts nor ends a line (second panel);
 *   P.  anywhere: two or more `=`, `END`, up to three LABEL_MODIFIERs, a noun,
 *       two or more `=` — `=== END SOURCE EVIDENCE ===`, `===ENDCLAIMS===`;
 *   L.  two or more `=`, `END`, whitespace, `:` or a dash, up to three
 *       LABEL_MODIFIERs, a noun — the one-sided `=== END EVIDENCE`;
 *   L'. two or more `=`, `END`, the noun with no separator, then only spaces to
 *       the end of the line — the one-sided compact `=== ENDEVIDENCE`;
 *   R.  `END` (not inside a word), whitespace, `:` or a dash, modifiers, a noun,
 *       two or more `=` — the one-sided `END EVIDENCE ===`;
 *   O.  three or more `=`, up to 80 letters, digits and separators, a noun,
 *       up to eight further words, a parenthetical, three or more `=` — a
 *       forged OPENING such as `=== EVIDENCE THE AGENT RETRIEVED (untrusted) ===`.
 *       Every real opening carries its parenthetical; requiring it keeps
 *       comment banners (`/* ===== VALIDATION RULES ===== *\/`) and
 *       `a === answer || b === c` out (`|` folds to `I`, so `answer || b`
 *       reads as the words ANSWER II B).
 *
 * Left alone, so ordinary code and prose in evidence is not rewritten (panel
 * and PR #1367 review): `x === endRules)`, `const endRules = x`,
 * `x === END_RULE`, `pos >= END_QUESTIONS`, `start = end_rules = 0`,
 * `if (kind === evidence)`, `a === answer || b === c`, banners with no
 * parenthetical, MediaWiki `== Evidence ==`, and every block-closing keyword
 * followed on the NEXT line by an assignment (`end` / `End If` / `END-IF` /
 * `end do` / SQL `END` then `rules = …`) — no form crosses a line break or
 * accepts a single `=`; and compound conditions such as
 * `return claim.status == ClaimStatus.CLOSED || claim.reserve == 0;` and
 * `if (a == end || rules == b)` (C is line-anchored; P, L and R take only
 * LABEL_MODIFIERs). Redacted although ordinary, because the folded copy cannot
 * tell them from a fence: a line ENDING in `=== endRules` (L'), and a heading
 * such as `=== Rules (draft) ===` (O).
 *
 * Bounded per start: every match begins at the first `=` of a run or at an
 * `E` not preceded by a letter or digit; C looks at most 200 characters ahead
 * (twice, once for the terminator and once for the noun), the filler is at
 * most 80 characters, a modifier at most 24, a parenthetical at most 200.
 */
const SEP = "[ \\t_-]*";
const SEP1 = "[ \\t_-]+";
/**
 * A label letter in the comparison copy. `L` also matches `I`: the fold reads a
 * lower-case `l` as `I` (it is `I`'s confusables prototype, see `PROTOTYPES`),
 * so `rules` folds to `RUIES` and `pipeline` to `PIPEIINE`.
 */
const letter = (c: string): string => (c === "L" ? "[LI]" : c);
const spaced = (word: string): string => [...word].map(letter).join(SEP);
const pluralisable = (word: string): string => `${spaced(word)}(?:${SEP}S)?`;
const SECTION_NOUN = `(?:${[
  pluralisable("FINDING"),
  spaced("EVIDENCE"),
  pluralisable("QUESTION"),
  pluralisable("ANSWER"),
  pluralisable("CLAIM"),
  pluralisable("RULE"),
  spaced("INVENTORY"),
  spaced("PIPELINE"),
  spaced("LINEAGE"),
].join("|")})`;
const MODIFIER = "[A-Z0-9+#]{1,24}";
const END = spaced("END");
/** A terminator word, not inside a word: END (ENDS, ENDED…) or CLOS (CLOSE, CLOSED, CLOSING…). */
const TERMINATOR = `(?<![A-Z0-9])(?:${END}|${spaced("CLOS")})`;
/** One character of a closing line: no `=`, no line break, no code operator. */
const LINE_CHAR = "[^=\\n\\r\\v\\f\\x85\\p{Zl}\\p{Zp}&;{}<>!?*]";
/** Between `===` and a noun, modifier words need no separator: `===SOURCEEVIDENCE(x)===`. */
const FILLER = "[A-Z0-9+# \\t_-]{0,80}?";
/**
 * After `END` on a ONE-SIDED form: whitespace, `:` or a dash, never `_` — so
 * the constants `x === END_RULE` and `pos >= END_QUESTIONS` are left alone.
 */
const AFTER_END = "[ \\t:-]+";
/**
 * A run of two (three) or more `=`, each pair optionally split by ONE separator
 * `-` — which is how a Markdown-escaped `\=\=\=` reads once `\` has folded to
 * `-`. A run starts only where no `=` (or `=-`) precedes it, so a long run is
 * never re-scanned from inside.
 */
const OPEN2 = "(?<!=-?)=(?:-?=)+";
const TAIL2 = "=(?:-?=)+";
const OPEN3 = "(?<!=-?)=(?:-?=){2,}";
const TAIL3 = "=(?:-?=){2,}";
/**
 * The words that sit between `END` and the noun in a real terminator
 * (`END SOURCE EVIDENCE`, `END SAS STEP PIPELINE`, `END C++ MINED RULES`, …),
 * plus `OF` / `THE` / `ALL`. A FIXED list on the one-sided forms, not "any
 * word": `|` folds to `I`, so `x == end || rules` would otherwise read as
 * `== END II RULES` (PR #1367 review, second panel).
 */
const LABEL_MODIFIER = `(?:${[
  "SOURCE",
  "MINED",
  "SAS",
  "STEP",
  "DATASET",
  "DATA",
  "PYTHON",
  "GO",
  "TYPESCRIPT",
  "JAVA",
  "KOTLIN",
  "COBOL",
  "SCALA",
  "RUST",
  "SQL",
  "OF",
  "THE",
  "ALL",
]
  .map(spaced)
  .join("|")}|C${SEP}(?:\\+${SEP}\\+|#)?)`;
/**
 * The section-fence forms (C, P, L, L', R, O above) for one vocabulary of nouns
 * and of the words that may sit between `END` and the noun. #1370 builds a
 * second instance for the docs-gen Phase-2 writer's blocks.
 *
 * `lineBoundOneSided` (the writer's instance) pins the one-sided forms L and R
 * to a line edge: L must run to the end of its line, R must start it. The
 * writer's nouns are common identifiers (`sources`, `facts`, `flow`), and the
 * free forms redacted code such as `if (pos == end - sources.length)` and
 * `if end - facts == 0:` (`.` folds to `-`).
 */
function sectionFenceForms(noun: string, modifier: string, lineBoundOneSided = false): string[] {
  const modifiers = `(?:${modifier}${SEP1}){0,3}`;
  const lineEnd = lineBoundOneSided ? "[ \\t]*(?=[\\n\\r]|$)" : "";
  const lineStart = lineBoundOneSided ? "(?<![^\\n\\r])[ \\t]*" : "(?<![A-Z0-9])";
  /** One closing line: the terminator and a noun in either order between two `=` runs. */
  const closingLine =
    `${OPEN2}(?=${LINE_CHAR}{0,200}?${TERMINATOR})(?=${LINE_CHAR}{0,200}?${noun})` +
    `${LINE_CHAR}{0,200}${TAIL2}`;
  return [
    // C: only as a whole line — at its start, or running to its end. A `==`
    // between two operands (`status == CLOSED || claim == 0`) is neither.
    `(?<![^\\n\\r])[ \\t]*${closingLine}`,
    `${closingLine}(?=[ \\t]*(?:[\\n\\r]|$))`,
    // Anywhere in a line, the plain shape: `=== END SOURCE EVIDENCE ===`, `===ENDCLAIMS===`.
    `${OPEN2}${SEP}${END}${SEP}${modifiers}${noun}${SEP}${TAIL2}`,
    `${OPEN2}${SEP}${END}${AFTER_END}${modifiers}${noun}${lineEnd}`,
    `${OPEN2}[ \\t]*${END}[A-Z0-9]{0,40}?${noun}[ \\t]*(?=[\\n\\r]|$)`,
    `${lineStart}${END}${AFTER_END}${modifiers}${noun}[ \\t]*${TAIL2}`,
    `${OPEN3}${FILLER}${noun}` +
      `(?:${SEP1}${MODIFIER}){0,8}${SEP}\\([^()=\\n]{0,200}\\)${SEP}${TAIL3}`,
  ];
}

const FOLDED_SECTION_FENCE = new RegExp(
  sectionFenceForms(SECTION_NOUN, LABEL_MODIFIER).join("|"),
  "gu",
);

/**
 * #1370 — the docs-gen Phase-2 writer's blocks: `=== EXTRACTED MODULE FACTS ===`
 * / `=== END MODULE FACTS ===`, `=== FORMULAS/CONSTANTS DETECTED IN SOURCE ===`
 * / `=== END FORMULAS ===`, `=== END-TO-END FLOW (…) ===` / `=== END FLOW ===`,
 * `=== RETRIEVED GROUNDING SOURCES ===` / `=== END GROUNDING SOURCES ===`, and
 * the `=== CANONICAL FACTS (…) ===` and `=== … SCHEMA … ===` / `=== END SCHEMA ===`
 * blocks that share the writer's prompt. The same forms as the section fences,
 * over the writer's nouns, plus:
 *
 *   W.  two or more `=`, one of the writer's OPENING phrases (`RETRIEVED
 *       GROUNDING SOURCES`, `EXTRACTED MODULE FACTS`, `CANONICAL FACTS`,
 *       `FORMULAS/CONSTANTS`, `DATABASE SCHEMA`, `TABLE AND COLUMN NAMES`,
 *       `END-TO-END FLOW`; the first word optional where the rest is
 *       distinctive), then anything but `=` or a line break, then two or more
 *       `=`. The real openings carry no parenthetical, so form O cannot see
 *       them; a fixed phrase is the structure ordinary text lacks (a wiki
 *       `=== Data flow ===` or a banner `===== CONSTANTS =====` is left alone);
 *   S.  a grounding-source header, `[SOURCE id=` — the block's own per-source
 *       label, which would let one source's text claim to be another source.
 */
const WRITER_NOUN = `(?:${[
  spaced("FLOW"),
  pluralisable("FACT"),
  pluralisable("FORMULA"),
  pluralisable("CONSTANT"),
  pluralisable("SOURCE"),
  spaced("SCHEMA"),
].join("|")})`;
const WRITER_MODIFIER = `(?:${[
  "MODULE",
  "GROUNDING",
  "CANONICAL",
  "EXTRACTED",
  "RETRIEVED",
  "DATABASE",
  "OF",
  "THE",
  "ALL",
]
  .map(spaced)
  .join("|")})`;
const WRITER_OPENING = `(?:${[
  `(?:${spaced("RETRIEVED")}${SEP})?${spaced("GROUNDING")}${SEP}${pluralisable("SOURCE")}`,
  `(?:${spaced("EXTRACTED")}${SEP})?${spaced("MODULE")}${SEP}${pluralisable("FACT")}`,
  `${spaced("CANONICAL")}${SEP}${pluralisable("FACT")}`,
  `${pluralisable("FORMULA")}[ \\t_/-]*${pluralisable("CONSTANT")}`,
  `${spaced("DATABASE")}${SEP}${spaced("SCHEMA")}`,
  `${spaced("TABLE")}${SEP1}${spaced("AND")}${SEP1}${spaced("COLUMN")}${SEP1}${spaced("NAMES")}`,
  `${END}${SEP}${spaced("TO")}${SEP}${END}${SEP}${spaced("FLOW")}`,
].join("|")})`;
const FOLDED_WRITER_FENCE = new RegExp(
  [
    ...sectionFenceForms(WRITER_NOUN, WRITER_MODIFIER, true),
    `${OPEN2}${SEP}${WRITER_OPENING}[^=\\n\\r\\v\\f\\x85\\p{Zl}\\p{Zp}]{0,200}${TAIL2}`,
    // A space between the words, as in the real header: `[source_id=…]` is left alone.
    `\\[[ \\t]*${spaced("SOURCE")}[ \\t]+${spaced("ID")}[ \\t]*=`,
  ].join("|"),
  "gu",
);

/**
 * #1369 — a support-panel excerpt header, `--- path:line ---` (or
 * `--- path:start-end ---`, `--- doc.md#chunk-N ---`, `--- path ---`), forged
 * inside an excerpt's body. A span is a WHOLE line (after spaces): three or
 * more `-` (any dash look-alike, and `.`, folds to `-`), whitespace, at most 300
 * characters holding a locator — a `:` before a digit, a `#`, or a `/` — then
 * whitespace and three or more `-`. Left alone: a Markdown rule `---`,
 * `--- Page 3 ---`, `----- Tables -----`, a commented banner
 * (`// --- a.ts:5 ---`), a diff header `--- a/x.ts` and `x = a --- b`.
 *
 * The digit class is `[0-9OI]` because the fold reads `0` as `O` and `1` as `I`; a
 * run of them must not run into a letter, so `--- Step 1: Only managers ---` and
 * `--- Note: Insert orders ---` (an `O` or `I` that starts a word) are left alone.
 * Linear: a span starts only at a line start, and each start scans at most 300
 * characters of one line.
 */
const LINE_BREAK = "\\n\\r\\v\\f\\x85\\p{Zl}\\p{Zp}";
const FOLDED_EXCERPT_HEADER = new RegExp(
  `(?<![^${LINE_BREAK}])[ \\t]*-{3,}[ \\t]+` +
    `(?=[^${LINE_BREAK}]{0,300}?(?::[ \\t]*[0-9OI]+(?![A-Z])|#|/))` +
    `[^${LINE_BREAK}]{1,300}?[ \\t]+-{3,}[ \\t]*(?=[${LINE_BREAK}]|$)`,
  "gu",
);

/**
 * #1360 — the impact run summary's `<<<IMPACTED ITEMS …>>> … <<<END ITEMS>>>`
 * terminator after any run of `<` (`<<END ITEMS>>`, `<END ITEMS>`,
 * `</END ITEMS>`, the one-sided `<<END ITEMS`) or before two or more `>`
 * (`END ITEMS>>`). A bare run of three or more brackets is
 * {@link FOLDED_REQUIREMENT_FENCE}'s. Only the terminator, as for the
 * requirement fence: `List<Item>` and `items >> 2` are ordinary text.
 */
const FOLDED_ITEMS_FENCE = new RegExp(
  `(?<!<)<+[\\s_/-]*${END}${SEP}${pluralisable("ITEM")}(?:${SEP}>+)?` +
    `|(?<![A-Z0-9])${END}${SEP}${pluralisable("ITEM")}${SEP}>{2,}`,
  "g",
);

/**
 * HTML character references, read as the character they encode. Bounded: at most
 * 7 decimal or 6 hex digits, so each `&` costs a constant amount of scanning.
 * `&lt` / `&gt` also decode WITHOUT the semicolon, as HTML's legacy parsing does
 * (`&lt&lt&ltEND REQUIREMENT`; PR #1362 review).
 */
const CHAR_REF =
  /&(?:#([0-9]{1,7});|#[xX]([0-9a-fA-F]{1,6});|(equals|hyphen|dash|lowbar|UnderBar|nbsp|period|middot|bsol|laquo|raquo|lsaquo|rsaquo);|(lt|gt|LT|GT);?)/y;
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
  // #1351 — the requirement fence.
  lt: 0x3c,
  gt: 0x3e,
  LT: 0x3c,
  GT: 0x3e,
  laquo: 0xab,
  raquo: 0xbb,
  lsaquo: 0x2039,
  rsaquo: 0x203a,
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
        : NAMED_REF[m[3] ?? m[4]];
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
  return scrubFolded(raw, replacement, FOLDED_FENCE);
}

/**
 * #1351 — the same scrub for the traceability prompts' requirement fence
 * (`FOLDED_REQUIREMENT_FENCE`): every span that reads as `<<<END REQUIREMENT>>>`,
 * `<<<REQUIREMENT>>>`, a one-sided form, or a run of three or more angle
 * brackets — exactly or through a look-alike — becomes `replacement`. Returns
 * `raw` itself when there is no such span.
 *
 * `replacement` must contain no `<`, `>` and no `REQUIREMENT` (`[REDACTED-FENCE]`).
 */
export function scrubRequirementFenceLookalikes(raw: string, replacement: string): string {
  return scrubFolded(raw, replacement, FOLDED_REQUIREMENT_FENCE);
}

/**
 * #1360 — the same scrub for the `=== LABEL ===` section fences
 * ({@link FOLDED_SECTION_FENCE}): every span that reads as a forged closing
 * line (`=== END EVIDENCE ===`, one-sided or compact) or a forged opening
 * (`=== EVIDENCE … ===`), exactly or through a look-alike, becomes
 * `replacement`. Returns `raw` itself when there is no such span.
 *
 * `replacement` must contain no `=` and no label word (`[REDACTED-FENCE]`).
 */
export function scrubSectionFenceLookalikes(raw: string, replacement: string): string {
  return scrubFolded(raw, replacement, FOLDED_SECTION_FENCE);
}

/**
 * #1360 — the impact run summary's short `END ITEMS` terminator
 * ({@link FOLDED_ITEMS_FENCE}). Use AFTER {@link scrubRequirementFenceLookalikes},
 * which covers every run of three or more brackets.
 *
 * `replacement` must contain no `<`, `>` and no `END ITEMS` (`[REDACTED-FENCE]`).
 */
export function scrubItemsFenceLookalikes(raw: string, replacement: string): string {
  return scrubFolded(raw, replacement, FOLDED_ITEMS_FENCE);
}

/**
 * #1370 — the same scrub for the docs-gen Phase-2 writer's blocks
 * ({@link FOLDED_WRITER_FENCE}): module facts, formulas, end-to-end flow,
 * retrieved grounding sources (and their `[SOURCE id=` headers), canonical
 * facts and the schema. Returns `raw` itself when there is no such span.
 *
 * `replacement` must contain no `=`, no `[SOURCE` and no noun (`[REDACTED-FENCE]`).
 */
export function scrubWriterFenceLookalikes(raw: string, replacement: string): string {
  return scrubFolded(raw, replacement, FOLDED_WRITER_FENCE);
}

/**
 * #1369 — a forged support-panel excerpt header ({@link FOLDED_EXCERPT_HEADER})
 * inside one excerpt's body. Returns `raw` itself when there is none.
 *
 * `replacement` must contain no `-` (`[REDACTED HEADER]`).
 */
export function scrubExcerptHeaderLookalikes(raw: string, replacement: string): string {
  return scrubFolded(raw, replacement, FOLDED_EXCERPT_HEADER);
}

function scrubFolded(raw: string, replacement: string, pattern: RegExp): string {
  if (raw.length === 0) return raw;

  // ASCII text without `&` folds one unit to one unit, so match offsets ARE the
  // original offsets: no walk, no map.
  if (ASCII_NO_REF.test(raw)) {
    let folded = "";
    for (let i = 0; i < raw.length; i++) folded += foldCodePoint(raw.charCodeAt(i));
    if (!hasMatch(folded, pattern)) return raw;
    return splice(
      raw,
      folded,
      (j) => j,
      (j) => j + 1,
      replacement,
      pattern,
    );
  }

  // Pass 1: the folded copy only. Most text has no fence, and then no offset
  // map is ever allocated.
  let folded = "";
  walk(raw, (f) => {
    folded += f;
  });
  if (!hasMatch(folded, pattern)) return raw;

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
    pattern,
  );
}

function hasMatch(folded: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(folded);
}

/** Replace each folded-copy match with `replacement`, at its ORIGINAL offsets. */
function splice(
  raw: string,
  folded: string,
  startOf: (j: number) => number,
  endOf: (j: number) => number,
  replacement: string,
  pattern: RegExp,
): string {
  pattern.lastIndex = 0;
  let out = "";
  let cursor = 0;
  for (let m = pattern.exec(folded); m !== null; m = pattern.exec(folded)) {
    // Widened to whole code points; never re-emit text already replaced.
    const from = Math.max(startOf(m.index), cursor);
    const to = Math.max(endOf(m.index + m[0].length - 1), from);
    out += raw.slice(cursor, from) + replacement;
    cursor = to;
  }
  return out + raw.slice(cursor);
}
