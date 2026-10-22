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
import { AMBIGUOUS_JSON_MESSAGE, parseBalancedJsonObject } from "./balanced-json.js";

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
    expect(parseBalancedJsonObject('{"a":1} , more')).toEqual({ found: false });
    expect(parseBalancedJsonObject('{"a":1}\n]')).toEqual({ found: false });
    expect(parseBalancedJsonObject('{"a":1}: x')).toEqual({ found: false });
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
    expect(extractJsonObject('like {this} then {"a":1} and {done}')).toEqual({ a: 1 });
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

describe("#1002 parseBalancedJsonObject", () => {
  it("reports not-found without throwing", () => {
    expect(parseBalancedJsonObject("")).toEqual({ found: false });
    expect(parseBalancedJsonObject("} { ")).toEqual({ found: false });
    expect(parseBalancedJsonObject("{not json}")).toEqual({ found: false });
    expect(parseBalancedJsonObject('{ "key" without a value }')).toEqual({ found: false });
    expect(parseBalancedJsonObject("{")).toEqual({ found: false });
    expect(parseBalancedJsonObject("{ }")).toEqual({ found: true, value: {} });
  });

  it("leadingOnly refuses an object that does not start the text", () => {
    expect(parseBalancedJsonObject('x {"a":1}', { leadingOnly: true })).toEqual({
      found: false,
    });
    expect(parseBalancedJsonObject('{bad} {"a":1}', { leadingOnly: true })).toEqual({
      found: false,
    });
    expect(parseBalancedJsonObject('{"a":1} then {"b":2}', { leadingOnly: true })).toEqual({
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
      expect(parseBalancedJsonObject(text)).toEqual({ found: false });
      expect(parseBalancedJsonObject(text, { leadingOnly: true })).toEqual({ found: false });
      // End to end: it throws, with the offset the truncation log reads (#1224).
      expect(() => extractJsonObject(text)).toThrow(/position \d+/);
      expect(() => extractJsonObject(`Result:\n${text}`)).toThrow(SyntaxError);
    });

    it.each([["{"], ["["], ['"']])("with no whitespace before %s", (token) => {
      expect(parseBalancedJsonObject(`{"a":1}${token}`)).toEqual({ found: false });
    });

    it("still accepts prose after the object, which is what the guard must not catch", () => {
      expect(parseBalancedJsonObject(`${LEADING}\nNote: see the config.`)).toEqual({
        found: true,
        value: JSON.parse(LEADING),
      });
      expect(parseBalancedJsonObject(`${LEADING}\n\`\`\`\nmore`)).toMatchObject({
        found: true,
      });
    });
  });

  it("does not treat a quote in the prose BETWEEN two brace spans as a string", () => {
    // The scan is already running (it started at `{x}`) and is back at depth 0
    // when it meets the lone quote. Opening a string there would swallow the
    // object that follows.
    expect(parseBalancedJsonObject('{x} it is 5" wide {"a":1}')).toEqual({
      found: true,
      value: { a: 1 },
    });
  });

  it("does not treat a quote in the prose before the first brace as a string", () => {
    expect(parseBalancedJsonObject('he said "hi {"a":1}')).toEqual({
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
        expect(parseBalancedJsonObject(input)).toEqual({ found: false });
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

/**
 * #1355 — "first parseable span wins" read a preamble example as the answer.
 * Decision: with no schema at this layer two different objects cannot be told
 * apart, so neither is returned and the caller re-prompts or repairs.
 */
describe("#1355 a preamble example followed by the real answer", () => {
  const EXAMPLE = { requirements: [{ title: "Example title", description: "..." }] };
  const ANSWER = { requirements: [{ title: "Login", description: "Users can log in" }] };
  const REPLY =
    `The answer has this shape: ${JSON.stringify(EXAMPLE)}.\n\n` +
    `Here is the answer:\n${JSON.stringify(ANSWER)}`;

  it("does not return the example as the answer", () => {
    expect(parseBalancedJsonObject(REPLY)).toEqual({ found: false, ambiguous: true });
  });

  it("extractJsonObject throws a SyntaxError that says how to fix the reply", () => {
    expect(() => extractJsonObject(REPLY)).toThrow(SyntaxError);
    expect(() => extractJsonObject(REPLY)).toThrow(AMBIGUOUS_JSON_MESSAGE);
  });

  it("is also ambiguous when the example comes AFTER a prefaced answer", () => {
    const after = `Answer: ${JSON.stringify(ANSWER)}\nFor reference: ${JSON.stringify(EXAMPLE)}`;
    expect(parseBalancedJsonObject(after)).toEqual({ found: false, ambiguous: true });
  });

  it("still returns the leading object when the reply starts with the answer", () => {
    const leading = `${JSON.stringify(ANSWER)}\nThe shape was ${JSON.stringify(EXAMPLE)}`;
    expect(extractJsonObject(leading)).toEqual(ANSWER);
  });

  it("accepts the same object written twice", () => {
    const twice = `Draft: ${JSON.stringify(ANSWER)}\nFinal: ${JSON.stringify(ANSWER, null, 2)}`;
    expect(parseBalancedJsonObject(twice)).toEqual({ found: true, value: ANSWER });
    expect(parseBalancedJsonObject(`${twice}\nAgain: ${JSON.stringify(ANSWER)}`)).toEqual({
      found: true,
      value: ANSWER,
    });
  });

  it("ignores prose spans and an unbalanced opener around the one object", () => {
    expect(parseBalancedJsonObject(`see {this}: ${JSON.stringify(ANSWER)} then {x} {`)).toEqual({
      found: true,
      value: ANSWER,
    });
  });

  it("is ambiguous on a different object after two identical ones", () => {
    const text = `a ${JSON.stringify(ANSWER)} b ${JSON.stringify(ANSWER)} c {"other":1}`;
    expect(parseBalancedJsonObject(text)).toEqual({ found: false, ambiguous: true });
  });

  it("stays linear on many identical objects separated by prose", () => {
    const make = (n: number): string => '{"a":1} x '.repeat(Math.floor(n / 10));
    const time = (n: number): number => {
      const input = make(n);
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        expect(parseBalancedJsonObject(input)).toEqual({ found: true, value: { a: 1 } });
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    time(1_000); // warm
    const small = time(100_000);
    const large = time(400_000);
    expect(large).toBeLessThan(2_000);
    // Linear is ~4x (measured 2.0 ms -> 8.5 ms); quadratic would be ~16x.
    expect(large).toBeLessThan(Math.max(small, 2) * 10);
  });
});
