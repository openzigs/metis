/**
 * #1253 — `extractJsonObject` carried `/```(?:json)?\s*([\s\S]*?)```/`, the
 * SAME quadratic fence pattern #1244 removed from `parseToolCall` one module
 * over. The greedy `\s*` sits immediately in front of the lazy `[\s\S]*?`, so
 * when the closing fence is absent every one of the `w` positions the
 * whitespace run can end at restarts a lazy scan that walks to end-of-input
 * hunting a ``` that never comes. Cost is O(w x n).
 *
 * It matters more here than it did in `agent-loop.ts`, because
 * `extractJsonObject` is the shared loose-JSON parser for the whole analysis
 * stack: `agentic-degradation.ts:74` calls it on the same untrusted model text
 * immediately after the now-fixed `parseToolCall`, and `synthesis.ts:419`,
 * `structured-verdict.ts:218`, `finding-deep-dive.ts:111` and
 * `orchestrator.ts:2222` each reach it on a model-output path.
 *
 * The fix is one token: drop `\s*`. Group 1 then swallows the leading
 * whitespace run instead.
 *
 * That is byte-identical for the PARSE, but — unlike `parseToolCall`, where
 * both uses of the capture trimmed — one of the two uses here does NOT trim:
 *
 *   if (fenceMatch && fenceMatch[1]) {      // <- raw truthiness, no trim
 *     const inner = fenceMatch[1].trim();   // <- trims
 *
 * So the guard's value genuinely changes, on exactly one input class: a fence
 * whose body is non-empty but all whitespace. Old capture `""` (the greedy
 * `\s*` ate it) is falsy and skips the branch; new capture `"   "` is truthy
 * and enters it. The outcome converges one line later, because `inner` trims
 * back to `""` and `"".startsWith("{")` is false, so both fall through to the
 * same brute-force path. The `whitespace-only fence body` cases below pin that
 * convergence rather than assuming it.
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

import { extractJsonObject } from "./agent-runner.js";

/**
 * The pre-#1253 pattern, verbatim, as the differential oracle. This regex is
 * the DEFECT — it is confined to this file and is only ever run over the short
 * fuzz strings, never over the 200 KB benchmark input.
 */
const OLD_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/;

/**
 * `extractJsonObject` exactly as it behaved before #1253.
 *
 * #1244's oracle delegated everything downstream of the extracted string back
 * to the real function. That is NOT sound here and is deliberately not done:
 * `extractJsonObject`'s quick path requires `endsWith("}")` as well as
 * `startsWith("{")`, so re-entering the real function with a truncated capture
 * like `{"a":1` would fall through to the brute-force branch and throw
 * `"Model response did not contain a JSON object"`, where the old fence branch
 * threw a `SyntaxError` from `JSON.parse`. The whole function is 15 lines and
 * its downstream is a single `JSON.parse`, so the oracle is a faithful copy
 * instead — which also means a change to any OTHER branch shows up here as a
 * divergence.
 */
function extractJsonObjectViaOldFence(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }
  const fenceMatch = trimmed.match(OLD_FENCE_PATTERN);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{")) return JSON.parse(inner);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Model response did not contain a JSON object");
}

/**
 * `extractJsonObject` with the fence branch DELETED. Used to count how many
 * corpus cases the fence branch actually decides: when this returns what the
 * real extractor returns, that case would pass the differential even with no
 * fence handling at all, and so pins nothing.
 */
function extractJsonObjectWithoutFence(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Model response did not contain a JSON object");
}

/**
 * `extractJsonObject` signals failure by THROWING, so a differential that only
 * compared return values would treat "threw SyntaxError at position 7" and
 * "threw SyntaxError at position 41" as equal — and those are precisely the
 * divergences a change to which string reaches `JSON.parse` would produce
 * (#1224 read a truncation offset off exactly this path). Envelope both
 * outcomes so the thrown message is compared as strictly as the parsed value.
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
 * regression and `server/vitest.config.ts` sets `retry: 2`, so a failing
 * timing assertion otherwise costs three full attempts.
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
 * measured at 200 KB on the machine this was written on:
 *
 *   fence + 100 KB spaces + 100 KB text (this shape)   1,503 ms
 *   fence + 200 KB text, no whitespace run                0.08 ms
 *   100 KB spaces + fence + 100 KB text                   0.05 ms
 *
 * It also must not both start with `{` and end with `}`, or the quick path is
 * taken first. Realistic, not contrived: a model that opens a ```json fence and
 * is then cut off mid-emission by an output cap produces precisely this, and
 * pretty-printed JSON is dense in indentation whitespace.
 */
function unclosedFenceInput(bytes: number): string {
  const half = Math.ceil(bytes / 2);
  return "Here is the result:\n```json\n" + " ".repeat(half) + "a".repeat(half);
}

/**
 * `extractJsonObject` throws on every benchmark input (an unclosed fence
 * carries no parseable object), so the timing helper must not let the throw
 * escape — and the throw is also the CORRECTNESS check: an extractor that were
 * fast because it bailed out early would otherwise pass the budget.
 */
function extractOrThrowSwallowed(input: string): void {
  try {
    extractJsonObject(input);
  } catch {
    /* expected — measured for cost, asserted separately below */
  }
}

describe("#1253 extractJsonObject is linear in input length", () => {
  /**
   * 50 ms is ~390x the measured cost of the FIXED function at 200 KB (0.128 ms,
   * measured end-to-end through `extractJsonObject`, not just the regex) — no
   * scheduler hiccup or cold JIT on a loaded runner reaches that — and ~31x
   * BELOW the quadratic cost at the same size (1,543 ms, measured by this very
   * test before the fix). Four orders of magnitude separate the two
   * implementations, so no plausible margin admits both: noise cannot trip the
   * threshold, and the quadratic cannot sneak under it.
   *
   * The same 50 ms #1244 chose, deliberately — the two functions carry the same
   * defect at the same input sizes, and a shared number is one fact to re-check
   * rather than two.
   */
  const BUDGET_MS = 50;

  it("parses a 200 KB unclosed-fence payload in under 50 ms", () => {
    const input = unclosedFenceInput(200 * 1024);
    expect(input.length).toBeGreaterThanOrEqual(200 * 1024);

    // Warm the JIT on a different, small input so the measured run times the
    // algorithm rather than the first-call compile.
    extractJsonObject('{"warm":true}');

    const ms = fastestMs(() => extractOrThrowSwallowed(input));

    // The verdict still has to be RIGHT — an extractor that is fast because it
    // gave up early would otherwise pass this test. An unclosed fence with no
    // brace carries no parseable object, so it must throw.
    expect(() => extractJsonObject(input)).toThrow(/did not contain a JSON object/);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it("scales linearly, not quadratically, with input length", () => {
    extractJsonObject('{"warm":true}');
    const small = fastestMs(() => extractOrThrowSwallowed(unclosedFenceInput(50 * 1024)));
    const large = fastestMs(() => extractOrThrowSwallowed(unclosedFenceInput(200 * 1024)));

    // 4x the input. Linear predicts ~4x the time; quadratic predicts ~16x. The
    // 25 ms floor keeps sub-millisecond noise from dominating the ratio at the
    // linear end, while 8x still rejects the quadratic one by ~4x (measured on
    // the old pattern: 93.5 ms at 50 KB vs 1,503 ms at 200 KB).
    expect(large).toBeLessThan(small * 8 + 25);
  }, 60_000);

  it("stays fast when the whitespace run is newlines rather than spaces", () => {
    // `\s` covers every whitespace class, so the trigger is not space-specific;
    // pretty-printed JSON that is cut off emits newlines and tabs, not spaces.
    const half = 100 * 1024;
    const input = "Result:\n```json\n" + "\n".repeat(half) + "a".repeat(half);
    extractJsonObject('{"warm":true}');

    const ms = fastestMs(() => extractOrThrowSwallowed(input));

    expect(() => extractJsonObject(input)).toThrow(/did not contain a JSON object/);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it("stays fast when the truncated payload also carries an unmatched brace", () => {
    // The realistic degraded-answer shape (`agentic-degradation.ts:74`): a
    // ```json fence, pretty-printed indentation, and a cut-off object. The
    // brute-force fallback then runs too, so this pins that the FENCE regex was
    // the cost rather than the parse that follows it.
    const half = 100 * 1024;
    const input =
      "Partial answer:\n```json\n" + " ".repeat(half) + '{"findings":[' + "a".repeat(half);
    extractJsonObject('{"warm":true}');

    const ms = fastestMs(() => extractOrThrowSwallowed(input));

    expect(() => extractJsonObject(input)).toThrow();
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);
});

describe("#1253 the fence capture is unchanged by dropping the whitespace class", () => {
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
   * so closing fences actually occur at these lengths), the `json` tag and its
   * near-misses exercise the optional `(?:json)?` that `\s*` sits behind, the
   * whitespace classes are what `\s*` consumed, and the braces decide which
   * downstream branch the capture lands in.
   *
   * The whole-object tokens are LOAD-BEARING, not decoration. #1244's first
   * corpus drew from an alphabet that could not spell `"tool"`, so every one of
   * 22,000 cases bottomed out at a guard, the differential compared `null` to
   * `null`, and a production regex replaced by one that never matches left 14
   * of 15 tests green. `extractJsonObject` has a lower bar than `parseToolCall`
   * — any parseable object counts — but the same trap applies: without complete
   * objects in the alphabet almost every case would throw on both sides, and
   * `throw:...` === `throw:...` is exactly as vacuous as `null` === `null`. The
   * `fenceDecisive` floors below are what stop it recurring.
   */
  const ALPHABET = [
    "`",
    "`",
    "```",
    "```",
    "json",
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
    '{"a":',
    '"a"',
    "1",
  ];

  /**
   * Does this input's first fence enclose a body that is non-empty but entirely
   * whitespace? That is the one input class where the two patterns hand a
   * DIFFERENT value to the un-trimmed `if (fenceMatch && fenceMatch[1])` guard.
   *
   * Deliberately derived from the class's DEFINITION rather than by matching
   * the shipped regex: a test that mirrors the implementation it is checking
   * pins nothing, and this counter's whole job is to prove the corpus reaches
   * the class. Verified to agree with the regex-derived class on all 22,000
   * corpus cases (112 short / 36 long, exactly).
   */
  function hasWhitespaceOnlyFenceBody(text: string): boolean {
    const trimmed = text.trim();
    const open = trimmed.indexOf("```");
    if (open < 0) return false;
    let bodyStart = open + 3;
    if (trimmed.startsWith("json", bodyStart)) bodyStart += 4;
    const close = trimmed.indexOf("```", bodyStart);
    if (close < 0) return false;
    const body = trimmed.slice(bodyStart, close);
    return body.length > 0 && body.trim() === "";
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
     * Cases in the ONE class where the two patterns produce a genuinely
     * different value at the un-trimmed use of the capture — the fence body is
     * non-empty but all whitespace, so the old capture is `""` (falsy, branch
     * skipped) and the new one is whitespace (truthy, branch entered). The
     * equivalence claim rests on those converging one line later; a corpus that
     * never generates the class has not tested that convergence at all.
     */
    truthinessDiverged: number;
  }

  function fuzz(seed: number, cases: number, maxTokens: number): FuzzStats {
    const random = makeRandom(seed);
    const stats: FuzzStats = { parsed: 0, fenceDecisive: 0, truthinessDiverged: 0 };
    for (let i = 0; i < cases; i++) {
      const length = 1 + Math.floor(random() * maxTokens);
      let text = "";
      for (let k = 0; k < length; k++) {
        text += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }

      const actual = outcomeOf(() => extractJsonObject(text));
      const expected = outcomeOf(() => extractJsonObjectViaOldFence(text));
      if (actual !== expected) {
        throw new Error(
          `extraction diverged for ${JSON.stringify(text)}: ` +
            `current=${actual} oldFence=${expected}`,
        );
      }
      if (actual.startsWith("ok:")) stats.parsed++;
      if (actual !== outcomeOf(() => extractJsonObjectWithoutFence(text))) {
        stats.fenceDecisive++;
      }
      if (hasWhitespaceOnlyFenceBody(text)) stats.truthinessDiverged++;
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
    const stats = fuzz(12345, 20_000, 12); // measured: 4,694 parsed / 304 decisive / 112 truthiness
    expect(stats.parsed).toBeGreaterThanOrEqual(2_300);
    expect(stats.fenceDecisive).toBeGreaterThanOrEqual(150);
    expect(stats.truthinessDiverged).toBeGreaterThanOrEqual(55);
  });

  it("agrees with the old regex on 2,000 longer fence-shaped strings", () => {
    const stats = fuzz(99991, 2_000, 120); // measured: 62 parsed / 245 decisive / 36 truthiness
    expect(stats.parsed).toBeGreaterThanOrEqual(30);
    expect(stats.fenceDecisive).toBeGreaterThanOrEqual(120);
    expect(stats.truthinessDiverged).toBeGreaterThanOrEqual(18);
  });

  /**
   * The shapes named in #1253's acceptance criteria, asserted on the outcome of
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
    // Fence body that is non-empty but ALL whitespace: the one input class
    // where `fenceMatch[1]`'s raw truthiness genuinely differs between the two
    // patterns (old `""` falsy, new `"   "` truthy). Both must still fall
    // through to the brute-force branch.
    ["```json   \n  \n```", "whitespace-only fence body, nothing else"],
    ['prose ```json   \n  \n``` tail {"a":4}', "whitespace-only fence body, brace after"],
    ['{"a":5} then ```   \n``` tail', "whitespace-only fence body, brace before"],
    // A near-miss language tag, so `(?:json)?` matches empty and `\s*` has
    // nothing to consume before a non-whitespace character.
    ['```jsonc\n{"a":6}\n```', "unknown tag"],
    // Backtick run around the payload.
    ['````{"a":7}````', "backtick run"],
    // Fence opener with a whitespace run and NO closing fence — the trigger
    // shape, at a size small enough to also run through the old regex.
    ["```json" + " ".repeat(64) + '{"a":8}', "unclosed fence"],
    // Two fences: leftmost-match semantics must be unchanged.
    ['prose ```json\n{"a":9}\n``` more ```json\n{"b":10}\n```', "two fences"],
    // Fence containing prose, so the capture does not start with `{` and the
    // brute-force branch decides — in both versions.
    ["```\nnot json at all\n```", "prose fence"],
    // Truncated capture: the fence branch reaches `JSON.parse` with an
    // unparseable string in BOTH versions, and the thrown SyntaxError message
    // carries an offset that would move if the capture changed by one byte.
    ['```json\n{"a":\n```', "truncated fenced object"],
    // No object at all — the terminal throw.
    ["nothing here", "no object"],
  ])("agrees on the %s case (%s)", (text) => {
    expect(outcomeOf(() => extractJsonObject(text))).toBe(
      outcomeOf(() => extractJsonObjectViaOldFence(text)),
    );
  });

  /**
   * Every assertion above this point compares the shipped extractor against the
   * oracle. That is the right shape for an EQUIVALENCE claim, but it passes
   * whenever both sides degrade together — and for a single fenced payload the
   * brute-force `{`-to-`}` fallback reproduces the same object, so those cases
   * also survive deleting the fence branch outright (#1244 adversarial panel,
   * test-falsifiability lens).
   *
   * These cases have no such escape: a second `}` appears after the fenced
   * object, so the brute-force slice spans past it and fails to parse. The
   * fence branch is the only thing that can produce the expected answer, and
   * the assertions are ABSOLUTE rather than differential.
   */
  it.each([
    ["two fenced objects", 'prose ```json\n{"a":9}\n``` more ```json\n{"b":10}\n```', { a: 9 }],
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
  ])("only the fence branch can decide the %s case", (_label, text, expected) => {
    // The fence branch produces the object...
    expect(extractJsonObject(text)).toEqual(expected);
    // ...and without it the extraction fails outright, so this case cannot pass
    // by accident the way a lone fenced payload can.
    expect(() => extractJsonObjectWithoutFence(text)).toThrow();
    // Unchanged by #1253, as ever.
    expect(extractJsonObjectViaOldFence(text)).toEqual(expected);
  });
});
