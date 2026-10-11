/**
 * #1002 — `extractJsonObject` recovers the object the model wrote even when
 * prose containing braces follows it, and stays linear while doing so.
 *
 * The reported failure was a deep-dive draft followed by commentary: the old
 * fallback sliced from the first `{` to the LAST `}`, handed the object plus
 * the commentary to `JSON.parse`, and the user was shown
 * `Unexpected non-whitespace character after JSON at position 2019`.
 */
import { describe, expect, it } from "vitest";

import { extractJsonObject } from "./agent-runner.js";
import { parseFirstBalancedJsonObject } from "./balanced-json.js";

const DRAFT = { title: "Add audit logging", affected: { files: ["a.go"], ids: [] } };

describe("#1002 extractJsonObject — balanced-brace extraction", () => {
  it("ignores trailing prose that contains braces (the reported shape)", () => {
    const text = `${JSON.stringify(DRAFT)}\n\nNote: wrap the handler in \`if (ok) { ... }\` first.`;
    expect(extractJsonObject(text)).toEqual(DRAFT);
  });

  it("ignores trailing prose that ENDS in a brace, which used to take the quick path", () => {
    // Starts with `{` and ends with `}` — the old quick path parsed the whole
    // string and threw before any fallback ran.
    const text = `${JSON.stringify(DRAFT)}\nThen close the block with }`;
    expect(extractJsonObject(text)).toEqual(DRAFT);
  });

  it("recovers an object with prose containing braces on BOTH sides", () => {
    const text = `Here you go (see {the schema}):\n${JSON.stringify(DRAFT)}\nDone {really}.`;
    expect(extractJsonObject(text)).toEqual(DRAFT);
  });

  it("keeps nested objects whole", () => {
    const nested = { a: { b: { c: [{ d: 1 }, { e: { f: 2 } }] } }, g: {} };
    expect(extractJsonObject(`answer: ${JSON.stringify(nested)} — see {x} }`)).toEqual(nested);
  });

  it("does NOT accept a leading object the model closed early and kept writing", () => {
    // Observed on long agent answers: the brackets diverge and the object
    // closes before its last array does. Taking the leading part would drop
    // the second finding silently; throwing sends it to repair / re-prompt.
    const diverged = '{"summary":"ok","findings":[{"title":"T"}]},{"title":"T2","body":"B2"}]}';
    expect(() => extractJsonObject(diverged)).toThrow(/position \d+/);
    expect(() => extractJsonObject(`Result:\n${diverged}`)).toThrow(SyntaxError);
    expect(() => extractJsonObject('{"a":1}} trailing }')).toThrow(SyntaxError);
    // ...and a later fragment followed by prose is not promoted in its place.
    expect(() => extractJsonObject('{"a":[1]}, {"b":2} done {')).toThrow(SyntaxError);
  });

  it("does not let a brace inside a string value close the object", () => {
    const tricky = { code: "if (x) { return }", close: "}", open: "{{{", n: 1 };
    expect(extractJsonObject(`${JSON.stringify(tricky)} trailing }`)).toEqual(tricky);
    expect(parseFirstBalancedJsonObject('{"a":1} , more')).toEqual({ found: false });
    expect(parseFirstBalancedJsonObject('{"a":1}\n]')).toEqual({ found: false });
    expect(parseFirstBalancedJsonObject('{"a":1}: x')).toEqual({ found: false });
  });

  it("respects escaped quotes and backslashes inside strings", () => {
    const tricky = { quote: 'say "}" twice', path: "C:\\dir\\", both: '\\"}' };
    expect(extractJsonObject(`=> ${JSON.stringify(tricky)} and a } after`)).toEqual(tricky);
  });

  it("prefers the leading object over a fenced snippet inside one of its strings", () => {
    // Inline, so the fence body starts with `{` (a fence that opens with an
    // escaped newline is skipped by the fence branch on its own).
    const draft = { title: "t", body: 'Set ```{"x":1}``` in the config.' };
    expect(extractJsonObject(`${JSON.stringify(draft)}\nHope that helps!`)).toEqual(draft);
  });

  it("skips a balanced span that is not JSON and takes the next one", () => {
    expect(extractJsonObject('like {this} then {"a":1} and {"b":2}')).toEqual({ a: 1 });
  });

  it("throws on truncated output instead of returning an inner fragment", () => {
    // The output cap cut the answer off mid-object. The complete INNER object
    // must not be mistaken for the answer.
    const truncated = '{"title":"t","affected":{"files":["a.go"]},"acceptanceCriteria":["one","tw';
    expect(() => extractJsonObject(truncated)).toThrow(SyntaxError);
    expect(() => extractJsonObject(`Sure:\n${truncated}`)).toThrow(SyntaxError);
  });

  it("still reports an offset on a malformed object, which the truncation log reads (#1224)", () => {
    expect(() => extractJsonObject('{"a": 1, "b" 2}')).toThrow(/position \d+/);
  });

  it("still throws the terminal error when there is no object at all", () => {
    expect(() => extractJsonObject("no braces")).toThrow(/did not contain a JSON object/);
    expect(() => extractJsonObject("only an opener {")).toThrow(/did not contain a JSON object/);
  });
});

describe("#1002 parseFirstBalancedJsonObject", () => {
  it("reports not-found without throwing", () => {
    expect(parseFirstBalancedJsonObject("")).toEqual({ found: false });
    expect(parseFirstBalancedJsonObject("} { ")).toEqual({ found: false });
    expect(parseFirstBalancedJsonObject("{not json}")).toEqual({ found: false });
    expect(parseFirstBalancedJsonObject('{ "key" without a value }')).toEqual({ found: false });
    expect(parseFirstBalancedJsonObject("{")).toEqual({ found: false });
    expect(parseFirstBalancedJsonObject("{ }")).toEqual({ found: true, value: {} });
  });

  it("leadingOnly refuses an object that does not start the text", () => {
    expect(parseFirstBalancedJsonObject('x {"a":1}', { leadingOnly: true })).toEqual({
      found: false,
    });
    expect(parseFirstBalancedJsonObject('{bad} {"a":1}', { leadingOnly: true })).toEqual({
      found: false,
    });
    expect(parseFirstBalancedJsonObject('{"a":1} then {"b":2}', { leadingOnly: true })).toEqual({
      found: true,
      value: { a: 1 },
    });
  });

  /**
   * PR #1084 review — the early-close guard covered `,` `]` `}` `:` and not
   * the three tokens that OPEN a sibling value. A model that closes its object
   * early does not always write the comma, and each of these shapes returned
   * the leading object with the rest of the answer dropped: a new silent
   * success, where `main` threw and the agent runner went to repair.
   */
  describe("declines a leading object that a sibling value follows", () => {
    const LEADING = '{"summary":"ok","findings":[{"title":"T"}]}';

    it.each([
      ["{", `${LEADING}\n{"title":"T2"}]}`],
      ["[", `${LEADING}\n[{"title":"T2"}]}`],
      ['"', `${LEADING}\n"title":"T2"}]}`],
    ])("when the continuation starts with %s", (_token, text) => {
      // The leading object parses on its own — that is the trap.
      expect(JSON.parse(LEADING)).toMatchObject({ summary: "ok" });
      expect(parseFirstBalancedJsonObject(text)).toEqual({ found: false });
      expect(parseFirstBalancedJsonObject(text, { leadingOnly: true })).toEqual({ found: false });
      // End to end: it throws, with the offset the truncation log reads (#1224).
      expect(() => extractJsonObject(text)).toThrow(/position \d+/);
      expect(() => extractJsonObject(`Result:\n${text}`)).toThrow(SyntaxError);
    });

    it.each([["{"], ["["], ['"']])("with no whitespace before %s", (token) => {
      expect(parseFirstBalancedJsonObject(`{"a":1}${token}`)).toEqual({ found: false });
    });

    it("still accepts prose after the object, which is what the guard must not catch", () => {
      expect(parseFirstBalancedJsonObject(`${LEADING}\nNote: see the config.`)).toEqual({
        found: true,
        value: JSON.parse(LEADING),
      });
      expect(parseFirstBalancedJsonObject(`${LEADING}\n\`\`\`\nmore`)).toMatchObject({
        found: true,
      });
    });
  });

  it("does not treat a quote in the prose BETWEEN two brace spans as a string", () => {
    // The scan is already running (it started at `{x}`) and is back at depth 0
    // when it meets the lone quote. Opening a string there would swallow the
    // object that follows.
    expect(parseFirstBalancedJsonObject('{x} it is 5" wide {"a":1}')).toEqual({
      found: true,
      value: { a: 1 },
    });
  });

  it("does not treat a quote in the prose before the first brace as a string", () => {
    expect(parseFirstBalancedJsonObject('he said "hi {"a":1}')).toEqual({
      found: true,
      value: { a: 1 },
    });
  });

  /**
   * Linear-time, asserted the way `agent-runner-fence-redos.test.ts` does it:
   * a RATIO between two sizes (so it holds on a slow runner) plus a generous
   * absolute ceiling. A scan that restarted from each inner `{` would be
   * quadratic on exactly this input — 400 KB of openers that never close —
   * and would take seconds, not a few milliseconds.
   */
  it.each([
    ["unclosed openers", (n: number) => "{".repeat(n), 500],
    ["an unterminated string", (n: number) => `{"a":"${"\\\\".repeat(n / 2)}`, 500],
    ["many prose spans", (n: number) => "{x}".repeat(Math.floor(n / 3)), 500],
    // Every span reaches `JSON.parse` and throws: linear, but with the slow
    // constant, so only the ratio is held tightly for it.
    ["many spans that fail to parse", (n: number) => '{"":}'.repeat(Math.floor(n / 5)), 5_000],
  ])("is linear on %s", (_label, make, ceilingMs) => {
    const time = (n: number): number => {
      const input = make(n);
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        expect(parseFirstBalancedJsonObject(input)).toEqual({ found: false });
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    time(1_000); // warm
    const small = time(100_000);
    const large = time(400_000);
    expect(large).toBeLessThan(ceilingMs);
    // 4x the input: linear is ~4x, quadratic ~16x. The floor keeps a
    // sub-millisecond `small` from turning timer noise into a failure.
    expect(large).toBeLessThan(Math.max(small, 1) * 10);
  });
});
