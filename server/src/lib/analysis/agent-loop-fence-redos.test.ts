/**
 * #1244 — `parseToolCall` extracted a fenced JSON payload with
 * `/```(?:json)?\s*([\s\S]*?)```/`. The greedy `\s*` in front of the lazy
 * `[\s\S]*?` is QUADRATIC when the closing fence is absent: `\s*` can end at any
 * of the `w` positions in the whitespace run after the opener, and for each one
 * the lazy scan walks to end-of-input hunting a ``` that never comes. Cost is
 * O(w x n).
 *
 * The work is synchronous, on the event loop, over untrusted model output, and
 * `classifyFinalAnswer` calls `parseToolCall` UNCONDITIONALLY — so #1220's
 * acceptance criterion "classifyFinalAnswer is linear in input length" covered
 * the brace-balance half it replaced but not this one. That residual is what
 * this file closes.
 *
 * The fix is one token: drop `\s*`. Group 1 then swallows the leading
 * whitespace, and BOTH call sites in `parseToolCall` already `.trim()` the
 * capture (`fenceMatch?.[1]?.trim().startsWith("{")` and
 * `JSON.parse(fenceMatch[1].trim())`), so the parsed payload is byte-identical.
 *
 * "Byte-identical" is exactly the kind of claim that deserves a differential
 * test rather than an assertion, so these tests pin both halves:
 *
 *  1. the benchmark — a 200 KB unclosed-fence input parses in linear time,
 *     on the CPU clock of the test's own thread (#1422);
 *  2. the equivalence — the shipped parser returns EXACTLY what the old regex
 *     returned, differentially, over a seeded corpus of fence-shaped strings.
 */
import { describe, expect, it } from "vitest";

import { expectLinearTime, threadCpuMs } from "../../../tests/helpers/linear-time.js";
import { parseToolCall } from "./agent-loop.js";

/**
 * The pre-#1244 pattern, verbatim, as the differential oracle. This regex is
 * the DEFECT — it is confined to this file and is only ever run over the short
 * fuzz strings, never over the 200 KB benchmark input.
 */
const OLD_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/;

const KNOWN_TOOLS = ["search_code_graph", "list_files", "read_file"];

/**
 * `parseToolCall` as it behaved before #1244.
 *
 * Only the FENCE EXTRACTION is reimplemented here; everything downstream of the
 * extracted string is delegated to the real `parseToolCall`, which is legitimate
 * because the two versions differ solely in which string reaches `JSON.parse`.
 * A `{`-leading string takes `parseToolCall`'s direct-JSON branch, which runs
 * `JSON.parse(trimmed)` and then the identical, unchanged post-processing — so
 * feeding it the old capture reproduces the old fence branch exactly, without
 * duplicating ~80 lines of flat-argument absorption that could drift.
 */
function parseToolCallViaOldFence(
  response: string,
  knownTools?: Iterable<string>,
): ReturnType<typeof parseToolCall> {
  const trimmed = response.trim();

  // Unchanged branch: a `{`-leading response never consults the fence at all.
  if (trimmed.startsWith("{")) return parseToolCall(trimmed, knownTools);

  const fenceMatch = trimmed.match(OLD_FENCE_PATTERN);
  if (fenceMatch?.[1]?.trim().startsWith("{")) {
    return parseToolCall(fenceMatch[1].trim(), knownTools);
  }

  // Brute-force branch: first `{` to last `}`. Identical in both versions, and
  // the slice starts with `{`, so the delegate takes the direct-JSON branch.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return parseToolCall(trimmed.slice(start, end + 1), knownTools);
  }
  return null;
}

/**
 * The adversarial payload, and the ONLY shape that triggers this quadratic: an
 * opening fence, a long whitespace run IMMEDIATELY after it, a long tail, and no
 * closing fence. Probing with the wrong payload makes the bug look absent —
 * measured at 200 KB on the machine this was written on:
 *
 *   fence + 100 KB spaces + 100 KB text (this shape)   1,461 ms
 *   fence + 200 KB text, no whitespace run                0.1 ms
 *   100 KB spaces + fence + 100 KB text                   0.1 ms
 *
 * It also must not start with `{`, or the direct-JSON branch is taken first.
 * Realistic, not contrived: a model that opens a ```json fence and is then cut
 * off mid-emission produces precisely this, and pretty-printed JSON is dense in
 * indentation whitespace.
 */
function unclosedFenceInput(bytes: number): string {
  const half = Math.ceil(bytes / 2);
  return "Here is the tool call:\n```json\n" + " ".repeat(half) + "a".repeat(half);
}

describe("#1244 parseToolCall is linear in input length", () => {
  /**
   * #1422 — `expectLinearTime` on this thread's CPU clock, not a 50 ms
   * wall-clock budget and a ratio. A descheduled worker in a full `pnpm test`
   * fan-out accrues no CPU time, so load cannot fail it; the quadratic can,
   * because it does the work: 1,461 ms at 200 KB (over the helper's 250 ms) and
   * ~16x the cost at a quarter of the size (over its ratio of 8). The fixed
   * parser is ~0.1 ms at 200 KB.
   */
  it("parses a 200 KB unclosed-fence payload in linear time", () => {
    const input = unclosedFenceInput(200 * 1024);
    expect(input.length).toBeGreaterThanOrEqual(200 * 1024);

    // Warm the JIT on a different, small input so the measured run times the
    // algorithm rather than the first-call compile.
    parseToolCall('{"tool":"list_files"}');

    // The verdict still has to be RIGHT — a parser that is fast because it gave
    // up early would otherwise pass this test. An unclosed fence carries no
    // parseable object, so it is a final answer.
    expect(parseToolCall(input, KNOWN_TOOLS)).toBeNull();
    expectLinearTime(
      "unclosed fence",
      (n) => {
        const at = unclosedFenceInput(n);
        return () => parseToolCall(at, KNOWN_TOOLS);
      },
      200 * 1024,
      threadCpuMs,
    );
  }, 60_000);

  it("stays linear when the whitespace run is newlines rather than spaces", () => {
    // `\s` covers every whitespace class, so the trigger is not space-specific;
    // pretty-printed JSON that is cut off emits newlines, not spaces.
    const newlines = (n: number) => "Result:\n```json\n" + "\n".repeat(n / 2) + "a".repeat(n / 2);
    parseToolCall('{"tool":"list_files"}');

    expect(parseToolCall(newlines(200 * 1024), KNOWN_TOOLS)).toBeNull();
    expectLinearTime(
      "newline run after a fence",
      (n) => {
        const at = newlines(n);
        return () => parseToolCall(at, KNOWN_TOOLS);
      },
      200 * 1024,
      threadCpuMs,
    );
  }, 60_000);
});

describe("#1244 the fence capture is unchanged by dropping the whitespace class", () => {
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
   * whitespace classes are what `\s*` consumed, and the braces and quotes decide
   * which downstream branch the capture lands in.
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
    "",
    "\f",
    " ",
    "{",
    "}",
    '"',
    ":",
    ",",
    "a",
    "[",
    "]",
    // Payload tokens — these are what let a generated string parse to a real
    // tool call, so the two compared values can differ from each other at all.
    //
    // They are load-bearing, not decoration. Without them the corpus could not
    // spell `"tool"`, every case bottomed out at `parseToolCall`'s
    // `if (!toolName) return null` guard, and the differential compared `null`
    // to `null` on all 22,000 iterations — 0 non-null parses, measured. The
    // fence branch fired ~200 times and still decided nothing observable, so
    // these tests passed with the production regex replaced by one that never
    // matches. Found by the #1244 adversarial panel (test-falsifiability lens);
    // the `fenceDecisive` floor below is what stops it recurring.
    '{"tool":"list_files"}',
    '{"tool":"search_code_graph","args":{"query":"x"}}',
    '{"tool":"read_file","path":"a.ts"}',
    '{"findings":[]}',
    '"tool"',
    "list_files",
    "t",
    "l",
    "o",
  ];

  /**
   * `parseToolCall` with the fence branch DELETED — first `{` to last `}` only.
   * Used to count how many corpus cases the fence branch actually decides: when
   * this returns what the real parser returns, that case would pass the
   * differential even with no fence handling at all, and so pins nothing.
   */
  function parseToolCallWithoutFence(
    text: string,
    knownTools?: Iterable<string>,
  ): ReturnType<typeof parseToolCall> {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) return parseToolCall(trimmed, knownTools);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return parseToolCall(trimmed.slice(start, end + 1), knownTools);
    return null;
  }

  interface FuzzStats {
    /** Cases whose parse returned a tool call rather than `null`. */
    nonNull: number;
    /**
     * Cases where the fence branch DECIDED the answer — deleting it would have
     * returned something different. This is the anti-vacuity measure: a corpus
     * with a `fenceDecisive` of zero cannot distinguish the old regex from the
     * new one, from a broken one, or from no fence branch at all.
     */
    fenceDecisive: number;
  }

  function fuzz(seed: number, cases: number, maxTokens: number): FuzzStats {
    const random = makeRandom(seed);
    const stats: FuzzStats = { nonNull: 0, fenceDecisive: 0 };
    for (let i = 0; i < cases; i++) {
      const length = 1 + Math.floor(random() * maxTokens);
      let text = "";
      for (let k = 0; k < length; k++) {
        text += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }
      // Alternate between the two `knownTools` modes: flat-argument absorption
      // only fires when the tool set is supplied.
      const knownTools = i % 2 === 0 ? KNOWN_TOOLS : undefined;

      const actual = parseToolCall(text, knownTools);
      const expected = parseToolCallViaOldFence(text, knownTools);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `parse diverged for ${JSON.stringify(text)}: ` +
            `current=${JSON.stringify(actual)} oldFence=${JSON.stringify(expected)}`,
        );
      }
      if (actual !== null) stats.nonNull++;
      if (JSON.stringify(actual) !== JSON.stringify(parseToolCallWithoutFence(text, knownTools))) {
        stats.fenceDecisive++;
      }
    }
    return stats;
  }

  // The floors sit at roughly half the measured counts. The corpus is seeded
  // and therefore deterministic, so these can only move when someone edits the
  // generator — which is exactly when they should be re-checked.
  it("agrees with the old regex on 20,000 short fence-shaped strings", () => {
    const stats = fuzz(12345, 20_000, 12); // measured: 2,881 non-null, 42 decisive
    expect(stats.nonNull).toBeGreaterThanOrEqual(1_400);
    expect(stats.fenceDecisive).toBeGreaterThanOrEqual(20);
  });

  it("agrees with the old regex on 2,000 longer fence-shaped strings", () => {
    const stats = fuzz(99991, 2_000, 120); // measured: 95 non-null, 24 decisive
    expect(stats.nonNull).toBeGreaterThanOrEqual(45);
    expect(stats.fenceDecisive).toBeGreaterThanOrEqual(12);
  });

  /**
   * The three shapes named in #1244's acceptance criteria, asserted on the
   * PARSED RESULT of the shipped function (not on a regex copied into this
   * file), with the old regex re-derived alongside so a divergence shows up as
   * a disagreement rather than as a stale hand-written expectation.
   */
  it("extracts a valid fenced tool call identically", () => {
    const text =
      'Here you go:\n```json\n{"tool": "search_code_graph", "args": {"query": "auth"}}\n```\nDone.';
    const expected = { tool: "search_code_graph", args: { query: "auth" } };

    expect(parseToolCall(text, KNOWN_TOOLS)).toEqual(expected);
    expect(parseToolCallViaOldFence(text, KNOWN_TOOLS)).toEqual(expected);
  });

  it("classifies a fenced findings payload as a final answer identically", () => {
    const text = '```json\n{"agentKey": "code", "findings": [{"title": "x", "body": "y"}]}\n```';

    expect(parseToolCall(text, KNOWN_TOOLS)).toBeNull();
    expect(parseToolCallViaOldFence(text, KNOWN_TOOLS)).toBeNull();
  });

  it("handles a backtick run around the payload identically", () => {
    const text = '````{"tool": "list_files", "args": {"pattern": "src/**"}}````';

    expect(parseToolCall(text, KNOWN_TOOLS)).toEqual(parseToolCallViaOldFence(text, KNOWN_TOOLS));
    expect(parseToolCall(text, KNOWN_TOOLS)).not.toBeNull();
  });

  it.each([
    // No language tag, no whitespace after the opener.
    ['```{"tool":"list_files"}```', "bare fence"],
    // Whitespace between the tag and the payload — the run `\s*` used to eat.
    ['```json   \n\n\t{"tool":"list_files"}\n```', "padded fence"],
    // Whitespace-only fence body: the capture trims to "" either way.
    ["```json   \n  \n```", "empty fence"],
    // A near-miss language tag, so `(?:json)?` matches empty and `\s*` has
    // nothing to consume before a non-whitespace character.
    ['```jsonc\n{"tool":"list_files"}\n```', "unknown tag"],
    // Fence opener with a whitespace run and NO closing fence — the trigger
    // shape, at a size small enough to also run through the old regex.
    ["```json" + " ".repeat(64) + '{"tool":"list_files"}', "unclosed fence"],
    // Two fences: leftmost-match semantics must be unchanged.
    [
      'prose ```json\n{"tool":"list_files"}\n``` more ```json\n{"tool":"read_file"}\n```',
      "two fences",
    ],
    // Fence containing prose, so the capture does not start with `{` and the
    // brute-force branch decides — in both versions.
    ["```\nnot json at all\n```", "prose fence"],
  ])("agrees on the %s case (%s)", (text) => {
    expect(JSON.stringify(parseToolCall(text, KNOWN_TOOLS))).toBe(
      JSON.stringify(parseToolCallViaOldFence(text, KNOWN_TOOLS)),
    );
  });

  /**
   * Every assertion above this point compares the shipped parser against the
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
    [
      "two fenced objects",
      'prose ```json\n{"tool":"list_files"}\n``` more ```json\n{"tool":"read_file"}\n```',
      { tool: "list_files", args: {} },
    ],
    [
      "a fenced object followed by prose containing a brace",
      'Use this:\n```json\n{"tool":"list_files"}\n```\nthen close the } block.',
      { tool: "list_files", args: {} },
    ],
  ])("only the fence branch can decide the %s case", (_label, text, expected) => {
    // The fence branch produces the tool call...
    expect(parseToolCall(text, KNOWN_TOOLS)).toEqual(expected);
    // ...and without it the parse fails outright, so this case cannot pass by
    // accident the way a lone fenced payload can.
    expect(parseToolCallWithoutFence(text, KNOWN_TOOLS)).toBeNull();
    // Unchanged by #1244, as ever.
    expect(parseToolCallViaOldFence(text, KNOWN_TOOLS)).toEqual(expected);
  });
});
