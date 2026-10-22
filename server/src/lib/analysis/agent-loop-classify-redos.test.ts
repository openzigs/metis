/**
 * #1220 — `classifyFinalAnswer` stripped string literals with
 * `/"(?:\\.|[^"\\])*"/g` before balancing braces. The alternation is unrolled,
 * so there is no EXPONENTIAL blowup, but the pattern is QUADRATIC: every quote
 * in a run of escaped quotes (`\"\"\"…`) starts a match attempt that scans to
 * end-of-input and fails, so an n-character run costs O(n²).
 *
 * That work is synchronous, on the event loop, over untrusted model output, and
 * it runs twice per degraded pass — so it stalls every other request in the
 * process, not just the analysis that triggered it. Measured in the #1218
 * review: 16 KB → 91 ms, 65 KB → 1,535 ms, 200 KB → 14,575 ms. #1218's
 * `ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS` made the bound operator-settable,
 * so the input is no longer capped at 4096 tokens.
 *
 * The fix is a single-pass linear scanner. These tests pin BOTH halves of that:
 *
 *  1. the benchmark — a 200 KB adversarial input classifies in linear time,
 *     on the CPU clock of the test's own thread (#1422);
 *  2. the equivalence — the scanner returns EXACTLY what the regex returned,
 *     differentially, over a seeded corpus of quote/backslash/brace strings. A
 *     scanner that is fast and subtly reclassifies degraded output is worse
 *     than the quadratic one, because it silently misroutes the repair triage.
 */
import { describe, expect, it } from "vitest";

import { expectLinearTime, threadCpuMs } from "../../../tests/helpers/linear-time.js";
import { classifyFinalAnswer, parseToolCall } from "./agent-loop.js";

/**
 * The pre-#1220 implementation, verbatim, as the differential oracle. The regex
 * below is the DEFECT — it is confined to this file and only ever run over the
 * short fuzz strings, never over the 200 KB benchmark input.
 */
function classifyFinalAnswerViaRegex(text: string): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "empty";
  if (parseToolCall(trimmed) !== null) return "tool-call";
  const start = trimmed.indexOf("{");
  if (start < 0) return "prose";
  const end = trimmed.lastIndexOf("}");
  if (end > start) {
    try {
      JSON.parse(trimmed.slice(start, end + 1));
      return "valid-json";
    } catch {
      // fall through to the balance check below
    }
  }
  const structural = trimmed.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const opens = structural.split("{").length - 1;
  const closes = structural.split("}").length - 1;
  return opens > closes ? "truncated-json" : "malformed-json";
}

/**
 * The adversarial payload: a truncated findings object whose final, unterminated
 * string value is a run of escaped quotes. Every `"` in that run is a candidate
 * match start for the old regex, and every attempt scans to the end of the input
 * before failing on the dangling escape — the quadratic term.
 *
 * It is a realistic shape, not a contrived one: a cut-off answer ends in an
 * unterminated string by construction, and a model quoting source code emits
 * `\"` freely. No `}` appears, so the classifier reaches the brace balance via
 * the same path a real truncated answer does.
 */
function adversarialInput(bytes: number): string {
  const prefix = '{"agentKey":"code","findings":[{"body":"';
  return prefix + '\\"'.repeat(Math.ceil((bytes - prefix.length) / 2));
}

describe("#1220 classifyFinalAnswer is linear in input length", () => {
  /**
   * #1422 — `expectLinearTime` on this thread's CPU clock, not a 50 ms
   * wall-clock budget and a ratio. A descheduled worker in a full `pnpm test`
   * fan-out accrues no CPU time, so load cannot fail it; the quadratic can,
   * because it does the work: 10,559 ms at 200 KB (over the helper's 250 ms)
   * and ~16x the cost at a quarter of the size (over its ratio of 8). The
   * scanner is ~2 ms at 200 KB.
   */
  it("classifies a 200 KB adversarial payload in linear time", () => {
    const input = adversarialInput(200 * 1024);
    expect(input.length).toBeGreaterThanOrEqual(200 * 1024);

    // Warm the JIT on a different, small input so the measured run times the
    // algorithm rather than the first-call compile.
    classifyFinalAnswer('{"a":"b"');

    // The verdict still has to be RIGHT — a classifier that is fast because it
    // gave up early would otherwise pass this test.
    expect(classifyFinalAnswer(input)).toBe("truncated-json");
    expectLinearTime(
      "escaped-quote run",
      (n) => {
        const at = adversarialInput(n);
        return () => classifyFinalAnswer(at);
      },
      200 * 1024,
      threadCpuMs,
    );
  }, 60_000);
});

describe("#1220 the scanner classifies identically to the regex it replaced", () => {
  /**
   * Deterministic LCG — a seeded corpus, so a mismatch is reproducible from the
   * failure message rather than being a heisenbug in CI.
   */
  function makeRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  /**
   * The alphabet is exactly the characters the two implementations can disagree
   * on: quote and backslash drive the string-literal state machine, the braces
   * are what is counted, and the line terminators are the one class of character
   * `\\.` cannot consume (`.` does not match a line terminator in JS), which is
   * where a naive scanner diverges from the regex.
   */
  const ALPHABET = [
    '"',
    "\\",
    "{",
    "}",
    "\n",
    "\r",
    // BOTH of the exotic line terminators. Omitting `\u2029` left the matching
    // disjunct of the scanner's `isLineTerminator` unexecuted by the whole
    // suite, so deleting it stayed green: the fuzz has to cover every
    // character class the two implementations branch on, or it is not an oracle
    // for them (#1220 adversarial panel, test-falsifiability lens).
    "\u2028",
    "\u2029",
    "a",
    " ",
    ":",
    ",",
    "[",
  ];

  function fuzz(seed: number, cases: number, maxLen: number): void {
    const random = makeRandom(seed);
    for (let i = 0; i < cases; i++) {
      const length = 1 + Math.floor(random() * maxLen);
      let text = "";
      for (let k = 0; k < length; k++) {
        text += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }
      const actual = classifyFinalAnswer(text);
      const expected = classifyFinalAnswerViaRegex(text);
      if (actual !== expected) {
        throw new Error(
          `classification diverged for ${JSON.stringify(text)}: ` +
            `scanner=${actual} regex=${expected}`,
        );
      }
    }
  }

  it("agrees with the regex on 20,000 short adversarial strings", () => {
    expect(() => fuzz(12345, 20_000, 14)).not.toThrow();
  });

  it("agrees with the regex on 2,000 longer adversarial strings", () => {
    expect(() => fuzz(99991, 2_000, 200)).not.toThrow();
  });

  it.each([
    // The #1218 case the strip exists for: a brace inside a string value.
    ['{"summary":"config uses { here",,"findings":[]}', "malformed-json"],
    // The truncation signature: an unterminated trailing string keeps its braces.
    ['{"findings":[{"body":"cut off here', "truncated-json"],
    // Braces inside an UNTERMINATED string are structural to both, because the
    // regex leaves unmatched text in place.
    ['{"body":"}}} unterminated', "malformed-json"],
    // An escaped quote does not close the literal, so the `{` inside it stays
    // hidden and the outer braces balance. Mishandle the escape and the literal
    // ends early, the `{` counts, and this misreports as `truncated-json`.
    ['{"body":"an \\" escaped quote {",,"findings":[]}', "malformed-json"],
    // A dangling backslash at end-of-input: `\\.` has nothing to consume, so the
    // literal never matches and its braces count.
    ['{"body":"trailing escape {\\', "truncated-json"],
    // A backslash before a newline: `.` cannot match a line terminator, so the
    // whole literal fails to match and everything in it counts.
    ['{"body":"broken \\\n escape }}}', "malformed-json"],
    // Balanced structural braces around a string that mentions both.
    ['{"body":"{ } { }",,"findings":[]}', "malformed-json"],
  ])("classifies %j as %s, exactly as the regex did", (text, expected) => {
    expect(classifyFinalAnswer(text)).toBe(expected);
    expect(classifyFinalAnswerViaRegex(text)).toBe(expected);
  });
});
