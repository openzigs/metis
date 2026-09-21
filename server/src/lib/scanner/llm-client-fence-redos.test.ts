/**
 * #1260 — `extractJson` in the scanner's LLM seam carried the FIFTH copy of the
 * quadratic markdown-fence regex, `/```(?:json)?\s*([\s\S]*?)```/i` — verbatim
 * the pattern #1244 removed from `parseToolCall` and #1253 removed from
 * `extractJsonObject`, modulo the `/i` flag.
 *
 * The greedy `\s*` sits immediately in front of the lazy `[\s\S]*?`. When the
 * closing fence is absent, each of the `w` positions the whitespace run can end
 * at restarts a lazy scan that walks to end-of-input hunting a ``` that never
 * comes. Cost is O(w x n) on untrusted model output. Fix: drop `\s*`.
 *
 * ── The equivalence argument, RE-DERIVED for THIS site ──────────────────────
 *
 * #1253 proved the argument does not transfer between call sites, only the
 * conclusion: #1244 rested on "both uses of the capture trim", and at #1253's
 * site only one did, so equivalence there held for a different reason (the
 * outcome converged a line later). So this is derived from scratch rather than
 * inherited.
 *
 * `extractJson` is nine lines from the fence to the fallback. Enumerating every
 * use of the match:
 *
 *   1. `if (fence)`            — the MATCH OBJECT, not the capture.
 *   2. `JSON.parse(fence[1].trim())` — the only use of the CAPTURE, and it
 *                                trims.
 *
 * There is no third use, and no un-trimmed use. Taking them in turn:
 *
 *   Use 1 is unchanged because the two patterns accept exactly the same
 *   language: `[\s\S]*?` subsumes everything `\s*` can match, so any string one
 *   matches the other matches. Nor can the match EXTENT move. Both patterns
 *   find the same leftmost opening fence, and the closing fence they settle on
 *   is the first ``` at or after the body start — the greedy `\s*` can never
 *   step OVER a closing fence, because a backtick is not whitespace. So
 *   `fence.index` and `fence[0]` are identical, and `if (fence)` is identical.
 *
 *   Use 2 changes the capture but not the string that reaches `JSON.parse`.
 *   Because `\s*` is greedy it consumed the MAXIMAL leading whitespace run `W`,
 *   so the old capture `X` either is empty or begins with a non-whitespace
 *   character, and the new capture is exactly `W ++ X`. Then
 *   `(W ++ X).trim() === X.trim()`: the leading trim removes `W` and, by
 *   maximality, X has no further leading whitespace to remove; the trailing
 *   trim sees the same suffix either way. Byte-identical string in, therefore
 *   identical value out — and identical `SyntaxError`, at the identical offset,
 *   when it throws.
 *
 * The all-whitespace fence body is the class that bit #1253, and it is benign
 * here for a stronger reason than convergence: old capture `""` and new capture
 * `"   "` both `.trim()` to `""` BEFORE anything reads them, so the two paths
 * are already identical at the single use rather than reconverging downstream.
 * The `whitespace-only fence body` cases below pin that rather than assume it.
 *
 * Two halves are pinned here:
 *
 *  1. the benchmark — a 200 KB unclosed-fence input parses in < 50 ms, and
 *     scales linearly rather than quadratically;
 *  2. the equivalence — the shipped extractor returns EXACTLY what the old
 *     regex returned (value or thrown error), differentially, over a seeded
 *     corpus of fence-shaped strings.
 */
import { describe, expect, it } from "vitest";

import { extractJson } from "./llm-client.js";

/**
 * The pre-#1260 pattern, verbatim including the `/i` flag, as the differential
 * oracle. This regex is the DEFECT — it is confined to this file and is only
 * ever run over the short fuzz strings, never over the 200 KB benchmark input.
 */
const OLD_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * `extractJson` exactly as it behaved before #1260.
 *
 * A faithful copy, NOT a delegation. #1244's oracle re-entered the real
 * function with the old capture, which was sound there; #1253 showed that
 * delegation is unsound wherever the quick path carries a second condition, and
 * the technique is only worth its risk when the downstream is long. Here the
 * downstream of the fence branch is a single `JSON.parse`, so a faithful
 * 20-line copy is both cheaper and stricter — a change to any OTHER branch of
 * `extractJson` also shows up here as a divergence.
 */
function extractJsonViaOldFence(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = OLD_FENCE_PATTERN.exec(trimmed);
  if (fence) {
    return JSON.parse(fence[1].trim());
  }
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace < 0) {
    throw new Error("no JSON object/array found in model output");
  }
  const head = trimmed[firstBrace];
  const tail = head === "{" ? "}" : "]";
  const lastTail = trimmed.lastIndexOf(tail);
  if (lastTail <= firstBrace) {
    throw new Error("unbalanced JSON in model output");
  }
  return JSON.parse(trimmed.slice(firstBrace, lastTail + 1));
}

/**
 * `extractJson` with the fence branch DELETED. Used to count how many corpus
 * cases the fence branch actually decides: when this returns what the real
 * extractor returns, that case would pass the differential even with no fence
 * handling at all, and so pins nothing.
 */
function extractJsonWithoutFence(raw: string): unknown {
  const trimmed = raw.trim();
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace < 0) {
    throw new Error("no JSON object/array found in model output");
  }
  const head = trimmed[firstBrace];
  const tail = head === "{" ? "}" : "]";
  const lastTail = trimmed.lastIndexOf(tail);
  if (lastTail <= firstBrace) {
    throw new Error("unbalanced JSON in model output");
  }
  return JSON.parse(trimmed.slice(firstBrace, lastTail + 1));
}

/**
 * `extractJson` signals failure by THROWING, so a differential that only
 * compared return values would treat "threw SyntaxError at position 7" and
 * "threw SyntaxError at position 41" as equal — and those are precisely the
 * divergences a change to which string reaches `JSON.parse` would produce.
 * Envelope both outcomes so the thrown message is compared as strictly as the
 * parsed value.
 */
function outcomeOf(fn: () => unknown): string {
  try {
    return `ok:${JSON.stringify(fn())}`;
  } catch (err) {
    return `throw:${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Fastest of `runs` timings, in ms. The MINIMUM is the right statistic for
 * "this implementation can do the work this fast" — a loaded CI runner can only
 * inflate a sample, never deflate one. Bails out once a single run exceeds
 * `abortAboveMs`, because no amount of repetition rescues a categorical
 * regression and `server/vitest.config.ts` sets `retry: 2`, so a failing timing
 * assertion otherwise costs three full attempts.
 */
function fastestMs(fn: () => unknown, runs = 3, abortAboveMs = 500): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    const elapsed = performance.now() - t0;
    best = Math.min(best, elapsed);
    if (elapsed > abortAboveMs) break;
  }
  return best;
}

/**
 * The adversarial payload, and the ONLY shape that triggers this quadratic: an
 * opening fence, a long whitespace run IMMEDIATELY after it, a long tail, and
 * no closing fence. Probing with the wrong payload makes the bug look absent —
 * measured at 200 KB on the machine this was written on, through this exact
 * function body:
 *
 *   fence + 100 KB spaces + 100 KB text (this shape)   1,513.55 ms
 *   fence + 200 KB text, no whitespace run                 0.13 ms
 *   100 KB spaces BEFORE the fence + 100 KB text           0.09 ms
 *
 * Two of the three obvious 200 KB payloads report the bug as absent. Realistic,
 * not contrived: a model that opens a ```json fence and is then cut off
 * mid-emission by an output cap produces precisely this, and pretty-printed
 * JSON is dense in indentation whitespace.
 */
function unclosedFenceInput(bytes: number): string {
  const half = Math.ceil(bytes / 2);
  return "Here is the result:\n```json\n" + " ".repeat(half) + "a".repeat(half);
}

/**
 * `extractJson` throws on every benchmark input (an unclosed fence carries no
 * parseable payload), so the timing helper must not let the throw escape — and
 * the throw is also the CORRECTNESS check: an extractor that were fast because
 * it bailed out early would otherwise pass the budget.
 */
function extractOrThrowSwallowed(input: string): void {
  try {
    extractJson(input);
  } catch {
    /* expected — measured for cost, asserted separately below */
  }
}

describe("#1260 scanner extractJson is linear in input length", () => {
  /**
   * 50 ms is ~287x the measured cost of the FIXED function at 200 KB (0.174 ms,
   * measured end-to-end through `extractJson`, not just the regex) — no
   * scheduler hiccup or cold JIT on a loaded runner reaches that — and ~30x
   * BELOW the quadratic cost at the same size (1,514 ms, measured on this exact
   * payload against the pre-fix source, and reproduced by this very test before
   * the fix at 1,514-1,538 ms across its five cases). Four orders of magnitude
   * separate the two implementations, so no plausible margin admits both: noise
   * cannot trip the threshold, and the quadratic cannot sneak under it.
   *
   * The same 50 ms #1244 and #1253 chose, deliberately — three copies of one
   * defect at the same input sizes is one number to re-check rather than three.
   */
  const BUDGET_MS = 50;

  it("parses a 200 KB unclosed-fence payload in under 50 ms", () => {
    const input = unclosedFenceInput(200 * 1024);
    expect(input.length).toBeGreaterThanOrEqual(200 * 1024);

    // Warm the JIT on a different, small input so the measured run times the
    // algorithm rather than the first-call compile.
    extractJson('{"warm":true}');

    const ms = fastestMs(() => extractOrThrowSwallowed(input));

    // The verdict still has to be RIGHT — an extractor that is fast because it
    // gave up early would otherwise pass this test. An unclosed fence with no
    // brace or bracket carries no parseable payload, so it must throw.
    expect(() => extractJson(input)).toThrow(/no JSON object\/array found/);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it("scales linearly, not quadratically, with input length", () => {
    extractJson('{"warm":true}');
    const small = fastestMs(() => extractOrThrowSwallowed(unclosedFenceInput(50 * 1024)));
    const large = fastestMs(() => extractOrThrowSwallowed(unclosedFenceInput(200 * 1024)));

    // 4x the input. Linear predicts ~4x the time; quadratic predicts ~16x. The
    // 25 ms floor keeps sub-millisecond noise from dominating the ratio at the
    // linear end, while 8x still rejects the quadratic one by ~4x (measured on
    // the old pattern: 94.4 ms at 50 KB vs 1,513.6 ms at 200 KB).
    expect(large).toBeLessThan(small * 8 + 25);
  }, 60_000);

  it("stays fast when the whitespace run is newlines rather than spaces", () => {
    // `\s` covers every whitespace class, so the trigger is not space-specific;
    // pretty-printed JSON that is cut off emits newlines and tabs, not spaces.
    const half = 100 * 1024;
    const input = "Result:\n```json\n" + "\n".repeat(half) + "a".repeat(half);
    extractJson('{"warm":true}');

    const ms = fastestMs(() => extractOrThrowSwallowed(input));

    expect(() => extractJson(input)).toThrow(/no JSON object\/array found/);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it("stays fast when the truncated payload also carries an unmatched brace", () => {
    // The realistic degraded shape on this seam: a scanner prompt demands a
    // JSON object, the model opens a ```json fence, pretty-prints, and is cut
    // off mid-object. The brute-force fallback then runs too, so this pins that
    // the FENCE regex was the cost rather than the search that follows it.
    const half = 100 * 1024;
    const input =
      "Partial answer:\n```json\n" + " ".repeat(half) + '{"findings":[' + "a".repeat(half);
    extractJson('{"warm":true}');

    const ms = fastestMs(() => extractOrThrowSwallowed(input));

    expect(() => extractJson(input)).toThrow(/unbalanced JSON/);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it("stays fast when the truncated payload is an ARRAY", () => {
    // `extractJson` accepts a top-level array as well as an object — the
    // scanner's rule-compiler and FP-filter both ask for one — so the array
    // fallback must be on the fast path too.
    const half = 100 * 1024;
    const input = "Findings:\n```json\t" + " ".repeat(half) + "[" + "a".repeat(half);
    extractJson("[1]");

    const ms = fastestMs(() => extractOrThrowSwallowed(input));

    expect(() => extractJson(input)).toThrow(/unbalanced JSON/);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);
});

describe("#1260 the fence capture is unchanged by dropping the whitespace class", () => {
  /**
   * Deterministic LCG — a seeded corpus, so a divergence is reproducible from
   * the failure message rather than being a heisenbug in CI.
   */
  function makeRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  /**
   * The alphabet is exactly the tokens the two patterns can disagree on: the
   * backtick drives fence detection (as a bare run AND as a ready-made triple,
   * so closing fences actually occur at these lengths), the `json` tag, its
   * upper-case form — this copy carries `/i`, unlike the other four — and its
   * near-misses exercise the optional `(?:json)?` that `\s*` sits behind, the
   * whitespace classes are what `\s*` consumed, and the braces and brackets
   * decide which downstream branch the capture lands in.
   *
   * The whole-payload tokens are LOAD-BEARING, not decoration. #1244's first
   * corpus drew from an alphabet that could not spell `"tool"`, so every one of
   * 22,000 cases bottomed out at a guard, the differential compared `null` to
   * `null`, and a production regex replaced by one that never matches left 14
   * of 15 tests green. Here the equivalent trap is that `throw:...` ===
   * `throw:...` is exactly as vacuous as `null` === `null`; without complete
   * payloads in the alphabet almost every case would throw on both sides. The
   * `fenceDecisive` floors below are what stop it recurring.
   */
  const ALPHABET = [
    "`",
    "`",
    "```",
    "```",
    "json",
    "JSON",
    "jso",
    "n",
    " ",
    "  ",
    "\n",
    "\t",
    "\r",
    "\f",
    " ",
    "{",
    "}",
    '"',
    ":",
    ",",
    "a",
    "[",
    "]",
    // Payload tokens — these are what let a generated string actually PARSE, so
    // the two compared outcomes can differ from each other at all.
    '{"a":1}',
    '{"b":{"c":2}}',
    '{"findings":[]}',
    '{"verdict":"ok"}',
    "{}",
    "[1,2]",
    '{"a":',
    '"a"',
    "1",
  ];

  /**
   * Does this input's first fence enclose a body that BEGINS with whitespace?
   * That is exactly the class where the two patterns hand a different string to
   * `fence[1]` — the old pattern's greedy `\s*` ate the run, the new one leaves
   * it in the capture. The equivalence claim is that `.trim()` erases the
   * difference; a corpus that never reaches the class has not tested that.
   *
   * Deliberately derived from the class's DEFINITION rather than by running the
   * shipped regex: a counter that mirrors the implementation it is checking
   * drifts with it and pins nothing. Verified to agree with the regex-derived
   * class on all 22,000 corpus cases (287 short / 312 long, zero
   * disagreements). The `.toLowerCase()` is this copy's `/i` flag.
   */
  function hasLeadingWhitespaceFenceBody(text: string): boolean {
    const trimmed = text.trim();
    const open = trimmed.indexOf("```");
    if (open < 0) return false;
    let bodyStart = open + 3;
    if (trimmed.slice(bodyStart, bodyStart + 4).toLowerCase() === "json") bodyStart += 4;
    const close = trimmed.indexOf("```", bodyStart);
    if (close < 0) return false;
    const body = trimmed.slice(bodyStart, close);
    return body.length > 0 && /^\s/.test(body);
  }

  interface FuzzStats {
    /** Cases whose extraction returned a value rather than throwing. */
    parsed: number;
    /**
     * Cases where the fence branch DECIDED the outcome — deleting it would have
     * produced something different. This is the anti-vacuity measure: a corpus
     * with a `fenceDecisive` of zero cannot distinguish the old regex from the
     * new one, from a broken one, or from no fence branch at all.
     */
    fenceDecisive: number;
    /**
     * Cases in the class where the two patterns produce a genuinely different
     * CAPTURE — the fence body begins with whitespace, so the old capture drops
     * it and the new one keeps it. The equivalence claim rests entirely on
     * `.trim()` erasing that difference at the single use of the capture, so a
     * corpus that never generates the class has tested nothing that matters.
     */
    captureDiverged: number;
  }

  function fuzz(seed: number, cases: number, maxTokens: number): FuzzStats {
    const random = makeRandom(seed);
    const stats: FuzzStats = { parsed: 0, fenceDecisive: 0, captureDiverged: 0 };
    for (let i = 0; i < cases; i++) {
      const length = 1 + Math.floor(random() * maxTokens);
      let text = "";
      for (let k = 0; k < length; k++) {
        text += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }

      const actual = outcomeOf(() => extractJson(text));
      const expected = outcomeOf(() => extractJsonViaOldFence(text));
      if (actual !== expected) {
        throw new Error(
          `extraction diverged for ${JSON.stringify(text)}: ` +
            `current=${actual} oldFence=${expected}`,
        );
      }
      if (actual.startsWith("ok:")) stats.parsed++;
      if (actual !== outcomeOf(() => extractJsonWithoutFence(text))) {
        stats.fenceDecisive++;
      }
      if (hasLeadingWhitespaceFenceBody(text)) stats.captureDiverged++;
    }
    return stats;
  }

  // The floors sit at roughly half the measured counts. The corpus is seeded
  // and therefore deterministic, so these can only move when someone edits the
  // generator — which is exactly when they should be re-checked. `fenceDecisive`
  // is the one that matters: it counts cases where deleting the fence branch
  // would change the answer, so a floor above zero is the standing proof that
  // this corpus can tell a working fence branch from a broken or absent one.
  it("agrees with the old regex on 20,000 short fence-shaped strings", () => {
    const stats = fuzz(12345, 20_000, 12); // measured: 5,114 parsed / 1,242 decisive / 287 capture
    expect(stats.parsed).toBeGreaterThanOrEqual(2_500);
    expect(stats.fenceDecisive).toBeGreaterThanOrEqual(600);
    expect(stats.captureDiverged).toBeGreaterThanOrEqual(140);
  });

  it("agrees with the old regex on 2,000 longer fence-shaped strings", () => {
    const stats = fuzz(99991, 2_000, 120); // measured: 76 parsed / 1,402 decisive / 312 capture
    expect(stats.parsed).toBeGreaterThanOrEqual(38);
    expect(stats.fenceDecisive).toBeGreaterThanOrEqual(700);
    expect(stats.captureDiverged).toBeGreaterThanOrEqual(150);
  });

  /**
   * The shapes named in #1260's acceptance criteria, asserted on the outcome of
   * the SHIPPED function with the old regex re-derived alongside, so a
   * divergence shows up as a disagreement rather than as a stale hand-written
   * expectation.
   */
  it.each([
    // No language tag, no whitespace after the opener.
    ['```{"a":1}```', "bare fence"],
    // The canonical happy path.
    ['```json\n{"a":2}\n```', "tagged fence"],
    // Whitespace between the tag and the payload — the run `\s*` used to eat.
    ['```json   \n\n\t{"a":3}\n```', "padded fence"],
    // Fence body that is non-empty but ALL whitespace. This is the class that
    // needed its own argument at #1253's site, because an un-trimmed use of the
    // capture flipped falsy to truthy there. Here the sole use trims first, so
    // old `""` and new `"   "` are already the same string when they are read —
    // pinned rather than assumed.
    ["```json   \n  \n```", "whitespace-only fence body, nothing else"],
    ['prose ```json   \n  \n``` tail {"a":4}', "whitespace-only fence body, brace after"],
    ['{"a":5} then ```   \n``` tail', "whitespace-only fence body, brace before"],
    // A near-miss language tag. `(?:json)?` is greedy-optional, so it DOES
    // consume `json` here and the capture opens on the leftover `c` — verified,
    // capture is `"c\n{\"a\":6}\n"` — leaving `\s*` nothing to eat before a
    // non-whitespace character. The bare-fence row above covers the other
    // branch, where `(?:json)?` genuinely matches empty.
    ['```jsonc\n{"a":6}\n```', "unknown tag"],
    // The `/i` flag is this copy's only difference from the other four, so the
    // upper-case tag must route through the same branch.
    ['```JSON\n{"a":7}\n```', "upper-case tag"],
    ['```JsOn   \n{"a":8}\n```', "mixed-case padded tag"],
    // Backtick run around the payload.
    ['````{"a":9}````', "backtick run"],
    // Fence opener with a whitespace run and NO closing fence — the trigger
    // shape, at a size small enough to also run through the old regex.
    ["```json" + " ".repeat(64) + '{"a":10}', "unclosed fence"],
    // Two fences: leftmost-match semantics must be unchanged.
    ['prose ```json\n{"a":11}\n``` more ```json\n{"b":12}\n```', "two fences"],
    // Fence containing prose, so the capture is not JSON and the fence branch
    // THROWS rather than falling through — in both versions.
    ["```\nnot json at all\n```", "prose fence"],
    // Truncated capture: the fence branch reaches `JSON.parse` with an
    // unparseable string in BOTH versions, and the thrown SyntaxError message
    // carries an offset that would move if the capture changed by one byte.
    ['```json\n{"a":\n```', "truncated fenced object"],
    // A top-level array, which this extractor accepts as well as an object.
    ["```json\n[1, 2, 3]\n```", "fenced array"],
    // No payload at all — the terminal throw.
    ["nothing here", "no payload"],
    // A brace with no closer — the `unbalanced JSON` throw.
    ["{ a:", "unbalanced"],
  ])("agrees on the %s case (%s)", (text) => {
    expect(outcomeOf(() => extractJson(text))).toBe(outcomeOf(() => extractJsonViaOldFence(text)));
  });

  /**
   * Every assertion above this point compares the shipped extractor against the
   * oracle. That is the right shape for an EQUIVALENCE claim, but it passes
   * whenever both sides degrade together — and for a single fenced payload the
   * brute-force `{`-to-`}` fallback reproduces the same object, so those cases
   * also survive deleting the fence branch outright (#1244 adversarial panel,
   * test-falsifiability lens).
   *
   * These cases have no such escape: a second closer appears after the fenced
   * payload, so the brute-force slice spans past it and fails to parse. The
   * fence branch is the only thing that can produce the expected answer, and
   * the assertions are ABSOLUTE rather than differential.
   */
  it.each([
    ["two fenced objects", 'prose ```json\n{"a":11}\n``` more ```json\n{"b":12}\n```', { a: 11 }],
    [
      "a fenced object followed by prose containing a brace",
      'Use this:\n```json\n{"a":1}\n```\nthen close the } block.',
      { a: 1 },
    ],
    [
      "a padded fenced object followed by a stray brace",
      '```json   \n\n\t{"nested":{"x":1}}\n```\ntrailing }',
      { nested: { x: 1 } },
    ],
    [
      "a padded fenced ARRAY followed by a stray bracket",
      "```JSON \t\n [1, 2, 3]\n```\ntrailing ]",
      [1, 2, 3],
    ],
  ])("only the fence branch can decide the %s case", (_label, text, expected) => {
    // The fence branch produces the payload...
    expect(extractJson(text)).toEqual(expected);
    // ...and without it the extraction fails outright, so this case cannot pass
    // by accident the way a lone fenced payload can.
    expect(() => extractJsonWithoutFence(text)).toThrow();
    // Unchanged by #1260, as ever.
    expect(extractJsonViaOldFence(text)).toEqual(expected);
  });
});
