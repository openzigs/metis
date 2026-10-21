/**
 * #1114 — neutralise text that LOOKS like a `===METIS-DATA-BOUNDARY===` fence.
 *
 * Every analysis prompt, and every tool result the agent loop shows a model, puts
 * untrusted text between `===METIS-DATA-BOUNDARY===` fences. Redacting only the
 * byte-exact fence (and its ASCII case/spacing variants) left a hole: text such
 * as full-width `＝＝＝METIS-DATA-BOUNDARY＝＝＝`, a zero-width or bidi character
 * inside the label, hyphen look-alikes, or Cyrillic/Greek homoglyphs is not the
 * fence, but a model reading it can take it for one and treat what follows as
 * instructions.
 *
 * How it works, without changing any text that is not fence-shaped:
 *
 *   1. Build a COMPARISON copy, one code point at a time: drop default-ignorable
 *      and format characters (`\p{Cf}`, `\p{Default_Ignorable_Code_Point}` —
 *      zero-width, bidi controls, soft hyphen, tag characters, variation
 *      selectors) and combining marks; fold compatibility forms (NFKD), case, and
 *      the Unicode confusables of the characters a fence is made of
 *      (`CONFUSABLES`). Each folded unit remembers the span of the original it
 *      came from.
 *   2. Find fence-shaped spans in that copy with one FIXED pattern.
 *   3. Replace the matching spans IN THE ORIGINAL. Everything else is returned
 *      byte-for-byte, so full-width CJK text, ligatures, superscripts and RTL
 *      text away from a fence are untouched and quoted snippets still match their
 *      chunk. Text with no fence-shaped span is returned as the same string.
 *
 * Linear in the length of the text: one pass to fold, one regex pass that cannot
 * backtrack across a run (see `FOLDED_FENCE`), one pass to splice.
 *
 * Dependency-free so both `analysis/prompts.ts` and `tool-runtime/fence.ts` can
 * use it.
 */

/**
 * Code points whose Unicode confusables skeleton is one of the characters a
 * fence is built from, and which NFKD + case folding does NOT already map there.
 *
 * Generated from Unicode `confusables.txt` (version dated 2026-08-06): every
 * single-code-point source whose prototype is `=`, `-`, `_`, or one of the
 * letters of METIS / DATA / BOUNDARY in either case (`I` takes the sources of
 * `l`, its prototype). Then the few the data does not list but a reader still
 * reads as a dash or an equals sign (`EXTRA_*`).
 */
const CONFUSABLE_SOURCES: ReadonlyArray<readonly [string, readonly number[]]> = [
  [
    "-",
    [
      0x02d7, 0x06d4, 0x174d, 0x1bf3, 0x2010, 0x2011, 0x2012, 0x2013, 0x2043, 0x2212, 0x2796,
      0x2cba, 0x2cbb, 0xaa7d, 0xfe58, 0x10191,
    ],
  ],
  ["=", [0x1400, 0x2e40, 0x30a0, 0xa4ff, 0xa60c, 0xa78a, 0x10190, 0x11053]],
  [
    "A",
    [
      0x0251, 0x0391, 0x03b1, 0x0410, 0x0430, 0x13aa, 0x15c5, 0x237a, 0xa4ee, 0xab64, 0x102a0,
      0x16f40, 0x1d6a8, 0x1d6c2, 0x1d6e2, 0x1d6fc, 0x1d71c, 0x1d736, 0x1d756, 0x1d770, 0x1d790,
      0x1d7aa, 0x1df5a, 0x1df6a,
    ],
  ],
  [
    "B",
    [
      0x0184, 0x0392, 0x0412, 0x042c, 0x07d5, 0x13cf, 0x13f4, 0x1472, 0x15af, 0x15f7, 0x2c82,
      0xa4d0, 0xa557, 0xa7b4, 0x10282, 0x102a1, 0x10301, 0x1031c, 0x16eb6, 0x1d207, 0x1d6a9,
      0x1d6e3, 0x1d71d, 0x1d757, 0x1d791,
    ],
  ],
  ["D", [0x0501, 0x13a0, 0x13e7, 0x146f, 0x15de, 0x15ea, 0xa4d2, 0xa4d3, 0x1018b]],
  [
    "E",
    [
      0x0395, 0x0415, 0x0435, 0x04bd, 0x13ac, 0x212e, 0x22ff, 0x2d39, 0xa4f0, 0xa5cb, 0xab32,
      0x10286, 0x118a6, 0x118ae, 0x1d6ac, 0x1d6e6, 0x1d720, 0x1d75a, 0x1d794, 0x1df81,
    ],
  ],
  [
    "I",
    [
      0x0031, 0x006c, 0x007c, 0x00a1, 0x0196, 0x01c0, 0x0269, 0x026a, 0x0399, 0x03b9, 0x0406,
      0x0456, 0x04c0, 0x04cf, 0x0582, 0x05c0, 0x05d5, 0x05df, 0x0627, 0x0661, 0x06f1, 0x07ca,
      0x0964, 0x104a, 0x13a5, 0x16c1, 0x16d0, 0x2113, 0x217c, 0x21bf, 0x2223, 0x2373, 0x23fd,
      0x2502, 0x2503, 0x2c92, 0x2c93, 0x2d4a, 0x2d4f, 0xa4f2, 0xa56f, 0xa647, 0xa781, 0xa7ae,
      0xa7fe, 0xa830, 0xa8ce, 0xaa5d, 0xab75, 0xfe31, 0xfe8d, 0xfe8e, 0xff11, 0xff4c, 0xff5c,
      0xffe8, 0x1028a, 0x10309, 0x10320, 0x1050e, 0x10926, 0x10c3e, 0x10ca5, 0x10cfa, 0x11047,
      0x110c0, 0x11141, 0x111c5, 0x113d4, 0x1144b, 0x115c5, 0x11641, 0x118c3, 0x11c41, 0x11dda,
      0x11de1, 0x16d63, 0x16eaa, 0x16f28, 0x1ccf1, 0x1d100, 0x1d377, 0x1d425, 0x1d459, 0x1d48d,
      0x1d4c1, 0x1d4f5, 0x1d529, 0x1d55d, 0x1d591, 0x1d5c5, 0x1d5f9, 0x1d62d, 0x1d661, 0x1d695,
      0x1d6b0, 0x1d6ca, 0x1d6ea, 0x1d704, 0x1d724, 0x1d73e, 0x1d75e, 0x1d778, 0x1d798, 0x1d7b2,
      0x1d7cf, 0x1d7d9, 0x1d7e3, 0x1d7ed, 0x1d7f7, 0x1e141, 0x1e8c7, 0x1ed01, 0x1ee00, 0x1ee80,
      0x1fbf1,
    ],
  ],
  [
    "M",
    [
      0x039c, 0x03fa, 0x041c, 0x13b7, 0x15f0, 0x16d6, 0x2c98, 0xa4df, 0x102b0, 0x10311, 0x10c21,
      0x1d6b3, 0x1d6ed, 0x1d727, 0x1d761, 0x1d79b,
    ],
  ],
  [
    "N",
    [
      0x039d, 0x0578, 0x057c, 0x2c9a, 0xa4e0, 0x10513, 0x11abe, 0x1d6b4, 0x1d6ee, 0x1d728, 0x1d762,
      0x1d79c,
    ],
  ],
  [
    "O",
    [
      0x0030, 0x039f, 0x03bf, 0x03c3, 0x03ed, 0x041e, 0x043e, 0x0555, 0x0585, 0x05e1, 0x0647,
      0x0665, 0x06be, 0x06c1, 0x06d5, 0x06f5, 0x07c0, 0x07cb, 0x0840, 0x0966, 0x09e6, 0x0a66,
      0x0ae6, 0x0b20, 0x0b66, 0x0be6, 0x0c02, 0x0c66, 0x0c82, 0x0ce6, 0x0d02, 0x0d20, 0x0d66,
      0x0d82, 0x0e50, 0x0ed0, 0x101d, 0x1040, 0x10ff, 0x110b, 0x11bc, 0x12d0, 0x17e0, 0x1a45,
      0x1a80, 0x1a90, 0x1bea, 0x1c82, 0x1cbf, 0x1d0f, 0x1d11, 0x2c9e, 0x2c9f, 0x2d54, 0x3007,
      0x3147, 0xa4f3, 0xab3d, 0xfba6, 0xfba7, 0xfba8, 0xfba9, 0xfbaa, 0xfbab, 0xfbac, 0xfbad,
      0xfee9, 0xfeea, 0xfeeb, 0xfeec, 0xff10, 0xffb7, 0x10292, 0x102ab, 0x1030f, 0x10404, 0x1042c,
      0x104c2, 0x104ea, 0x10516, 0x1092c, 0x10c17, 0x10d07, 0x11124, 0x11302, 0x114d0, 0x118b5,
      0x118c8, 0x118d7, 0x118e0, 0x11de0, 0x16ae9, 0x1ccf0, 0x1d6b6, 0x1d6d0, 0x1d6d4, 0x1d6f0,
      0x1d70a, 0x1d70e, 0x1d72a, 0x1d744, 0x1d748, 0x1d764, 0x1d77e, 0x1d782, 0x1d79e, 0x1d7b8,
      0x1d7bc, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1ee24, 0x1ee84,
      0x1fbf0,
    ],
  ],
  [
    "R",
    [
      0x01a6, 0x024c, 0x0433, 0x13a1, 0x13d2, 0x1587, 0x1d26, 0x2c85, 0xa4e3, 0xab47, 0xab48,
      0xab81, 0x104b4, 0x16a19, 0x16f35, 0x1d216,
    ],
  ],
  [
    "S",
    [
      0x01bd, 0x0405, 0x0455, 0x054f, 0x0d1f, 0x10bd, 0x10fd, 0x13d5, 0x13da, 0x1cbd, 0xa4e2,
      0xa576, 0xa731, 0xabaa, 0x10296, 0x10420, 0x10448, 0x118c1, 0x16ad6, 0x16f3a,
    ],
  ],
  [
    "T",
    [
      0x03a4, 0x0422, 0x07e0, 0x13a2, 0x22a4, 0x27d9, 0x2ca6, 0x3112, 0x4e05, 0xa4d4, 0xa50b,
      0x10297, 0x102b1, 0x10315, 0x118bc, 0x16f0a, 0x1d373, 0x1d6bb, 0x1d6f5, 0x1d72f, 0x1d769,
      0x1d7a3, 0x1f768,
    ],
  ],
  [
    "U",
    [
      0x028b, 0x03c5, 0x054d, 0x057d, 0x1200, 0x144c, 0x1d1c, 0x222a, 0x22c3, 0xa4f4, 0xa79f,
      0xab4e, 0xab52, 0x104ce, 0x104f6, 0x118b8, 0x118d8, 0x16f42, 0x1d6d6, 0x1d710, 0x1d74a,
      0x1d784, 0x1d7be,
    ],
  ],
  [
    "Y",
    [
      0x0263, 0x028f, 0x03a5, 0x03b3, 0x03d2, 0x0423, 0x0443, 0x04ae, 0x04af, 0x07cc, 0x10e7,
      0x13a9, 0x13bd, 0x1d8c, 0x1eff, 0x213d, 0x2ca8, 0x2ca9, 0x311a, 0x4e2b, 0xa4ec, 0xab5a,
      0x102b2, 0x10c20, 0x118a4, 0x118c4, 0x118dc, 0x16f43, 0x1d6bc, 0x1d6c4, 0x1d6f6, 0x1d6fe,
      0x1d730, 0x1d738, 0x1d76a, 0x1d772, 0x1d7a4, 0x1d7ac,
    ],
  ],
  ["_", [0x0640, 0x07fa, 0x145c1]],
];

/** Dashes and bars a reader takes for `-`, absent from the confusables data. */
const EXTRA_DASHES = [0x2014, 0x2015, 0x2500, 0x2501, 0x2e3a, 0x2e3b];
/** Double horizontal bar: read as `=`. */
const EXTRA_EQUALS = [0x2550];

export const CONFUSABLES: ReadonlyMap<number, string> = new Map<number, string>([
  ...CONFUSABLE_SOURCES.flatMap(([to, from]) => from.map((c) => [c, to] as const)),
  ...EXTRA_DASHES.map((c) => [c, "-"] as const),
  ...EXTRA_EQUALS.map((c) => [c, "="] as const),
]);

/** Dropped from the comparison copy: invisible, formatting, or combining. */
const IGNORABLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]/gu;

/**
 * A fence-shaped span in the comparison copy: a run of `=`, the letters of
 * METIS DATA BOUNDARY with any whitespace, `-` or `_` between them, and a run of
 * `=`. The same shape the exact-fence scrub always matched, now over folded text.
 *
 * `(?<!=)` makes a match start only at the FIRST `=` of a run. Without it, a long
 * run of `=` that is not followed by the label is re-scanned from every position
 * in it: the old pattern took quadratic time on 200 KB of `=` (#1114).
 */
const FOLDED_FENCE =
  /(?<!=)=+[\s_-]*M[\s_-]*E[\s_-]*T[\s_-]*I[\s_-]*S[\s_-]*D[\s_-]*A[\s_-]*T[\s_-]*A[\s_-]*B[\s_-]*O[\s_-]*U[\s_-]*N[\s_-]*D[\s_-]*A[\s_-]*R[\s_-]*Y[\s_-]*=+/g;

/**
 * ASCII text folds one unit to one unit, so it needs no index map (fast path).
 */
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** Non-global twin of {@link IGNORABLE} for testing a single code point. */
const IGNORABLE_SINGLE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]$/u;

const foldMemo = new Map<number, string>();
const FOLD_MEMO_LIMIT = 4096;

/** The comparison form of one code point (may be empty, or several units). */
function foldCodePoint(cp: number, ch: string): string {
  const direct = CONFUSABLES.get(cp);
  if (direct !== undefined) return direct;
  if (cp < 0x80) return ch.toUpperCase();
  const memo = foldMemo.get(cp);
  if (memo !== undefined) return memo;
  let out = "";
  for (const part of ch.normalize("NFKD").replace(IGNORABLE, "")) {
    out += CONFUSABLES.get(part.codePointAt(0) as number) ?? part.toUpperCase();
  }
  if (foldMemo.size < FOLD_MEMO_LIMIT) foldMemo.set(cp, out);
  return out;
}

/**
 * Replace every span of `raw` that reads as the data-boundary fence — exactly,
 * or through a Unicode look-alike — with `replacement`. Returns `raw` itself
 * when there is no such span.
 */
export function scrubFenceLookalikes(raw: string, replacement: string): string {
  if (raw.length === 0) return raw;

  // ASCII text folds unit for unit (case, plus `0`/`1`/`l`/`|`), so the match
  // offsets ARE the original offsets and no index map is needed.
  if (ASCII_ONLY.test(raw)) {
    let folded = "";
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      folded += CONFUSABLES.get(code) ?? raw[i].toUpperCase();
    }
    return splice(
      raw,
      folded,
      (i) => i,
      (i) => i + 1,
      replacement,
    );
  }

  // General path: build the folded copy and, per folded unit, the original
  // [start, end) it came from.
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const cp = raw.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    const ch = width === 2 ? raw.slice(i, i + 2) : raw[i];
    // Confusables first: a few are spacing marks (U+0C02 reads as `o`), which
    // the ignorable test would otherwise drop.
    const f = CONFUSABLES.has(cp) || !IGNORABLE_SINGLE.test(ch) ? foldCodePoint(cp, ch) : "";
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + width);
    }
    folded += f;
    i += width;
  }
  return splice(
    raw,
    folded,
    (j) => starts[j],
    (j) => ends[j],
    replacement,
  );
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
  let matched = false;
  for (let m = FOLDED_FENCE.exec(folded); m !== null; m = FOLDED_FENCE.exec(folded)) {
    const from = startOf(m.index);
    const to = endOf(m.index + m[0].length - 1);
    out += raw.slice(cursor, from) + replacement;
    cursor = to;
    matched = true;
  }
  return matched ? out + raw.slice(cursor) : raw;
}
