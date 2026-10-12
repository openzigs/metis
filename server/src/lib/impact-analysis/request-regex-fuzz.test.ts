/**
 * Every regular expression in the impact chain's production files, timed on
 * adversarial input.
 *
 * WHY THIS EXISTS. Request text is accepted up to 500,000 characters
 * (`createImpactAnalysisSchema`), and PR #1090 shipped a quadratic pattern on it
 * three times: the time-bound prefix (14 s at 160 KB), then — in the commit that
 * fixed it — the bold-heading line (23 s at 200 KB), with a third reached through
 * the search tokenizer (19 s). Each fix came with a timing test for the pattern
 * the review had named, and none for the pattern beside it.
 *
 * So this test names no pattern. It parses each file below with the TypeScript
 * compiler, takes EVERY regex literal and EVERY `new RegExp(…)` it finds, and
 * runs each over every input in {@link ADVERSARIAL_INPUTS}. A pattern added to
 * one of these files tomorrow is covered without anyone remembering to add it.
 *
 * What it does not do: decide which patterns see request text. It does not need
 * to — every pattern in a listed file has to be linear, whatever it is applied
 * to. A `new RegExp` whose source cannot be evaluated statically FAILS the test
 * rather than being skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The production files of the impact chain that PR #1090 (#1036, #791, #1051)
 * touches, plus the search tokenizer its queries reach. Add a file here when a
 * change makes it read request text.
 */
export const FUZZED_FILES: readonly string[] = [
  "lib/impact-analysis/additive-column-proposer.ts",
  "lib/impact-analysis/change-request.ts",
  "lib/impact-analysis/change-seeds.ts",
  "lib/impact-analysis/column-proposal-gate.ts",
  "lib/impact-analysis/data-path-writers.ts",
  "lib/impact-analysis/extract-changes.ts",
  "lib/impact-analysis/impact-analysis-engine.ts",
  "lib/impact-analysis/impact-analysis-read.ts",
  "lib/impact-analysis/impact-roles.ts",
  "lib/impact-analysis/schema-impact.ts",
  "lib/impact-analysis/structural-twins.ts",
  "lib/code-graph/hybrid-search.ts",
  "lib/code-graph/project-code-searcher.ts",
  "lib/rag/fused-code-context.ts",
];

/** Size of every input. The review's measurements were taken at this size. */
const SIZE = 200_000;
/**
 * Each input is tried at these sizes in turn, smallest first, and a pattern
 * fails at the first one that exceeds the bound. Going straight to 200 KB would
 * be enough to FAIL a quadratic pattern (seconds) but would HANG on a cubic one
 * (an unanchored `\s*:?\s*$` does not return in fifteen minutes) and on an
 * exponential one, and a hung worker reports nothing. On the ladder a cubic
 * pattern fails near 1,000 characters and `(a+)+$` by 32, each within seconds.
 */
const LADDER: readonly number[] = [
  24,
  28,
  32,
  250,
  500,
  1000,
  2000,
  4000,
  8000,
  16_000,
  32_000,
  64_000,
  128_000,
  SIZE,
];
/**
 * Generous: a linear pattern takes 0 to 30 ms here, the quadratic ones this
 * test was written for take 3,000 to 23,000.
 */
const BOUND_MS = 250;

type Build = (size: number) => string;
/** `unit` repeated to exactly `size` characters. */
const fill =
  (unit: string): Build =>
  (size) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** `head`, a run of `filler`, then `tail`: the shape that defeats `X\s*$`. */
const sandwich =
  (head: string, filler: string, tail: string): Build =>
  (size) =>
    (head + fill(filler)(Math.max(0, size - head.length - tail.length)) + tail).slice(0, size);

/** Each input is a recipe: the same shape at any size on the {@link LADDER}. */
export const ADVERSARIAL_INPUTS: ReadonlyArray<readonly [name: string, build: Build]> = [
  // whitespace-free tokens
  ["lower-case run", fill("a")],
  ["upper-case run", fill("A")],
  ["upper-case run, then lower", sandwich("", "A", "a")],
  ["digit run", fill("7")],
  // a run that almost matches, then one character that does not: `(a+)+$`
  ["lower-case run, then a char", sandwich("", "a", "!")],
  ["digit run, then a char", sandwich("", "7", "x")],
  ["dots, then a char", sandwich("", ".", "x")],
  ["dotted token a.a.a", fill("a.")],
  ["dotted digits 1.1.1", fill("1.")],
  ["snake token a_b_c", fill("a_")],
  ["camel token aBaB", fill("aB")],
  ["pascal token AbAb", fill("Ab")],
  ["url, one long path", sandwich("https://example.com/", "a", "")],
  ["minified json", fill('{"a":1,"b":[2,3]},')],
  // whitespace
  ["spaces", fill(" ")],
  ["tabs", fill("\t")],
  ["newlines", fill("\n")],
  ["crlf", fill("\r\n")],
  ["spaces then a char", sandwich("", " ", "x")],
  ["word, spaces, char", sandwich("a", " ", "x")],
  ["bold, spaces, char", sandwich("**a**", " ", "x")],
  ["bold, spaces, colon, spaces, char", sandwich("**a**:", " ", "x")],
  ["heading, spaces, char", sandwich("# a", " ", "x")],
  ["colon, spaces, char", sandwich("a:", " ", "x")],
  ["brace, spaces, char", sandwich("func f() {", " ", "x")],
  ["paren group, spaces, char", sandwich("a (b)", " ", "x")],
  ["words", fill("a ")],
  ["upper-case words", fill("AB ")],
  // one punctuation character
  ["open brackets", fill("[")],
  ["close brackets", fill("]")],
  ["open parens", fill("(")],
  ["close parens", fill(")")],
  ["asterisks", fill("*")],
  ["underscores", fill("_")],
  ["hashes", fill("#")],
  ["backticks", fill("`")],
  ["question marks", fill("?")],
  ["exclamation marks", fill("!")],
  ["full stops", fill(".")],
  ["colons", fill(":")],
  ["commas", fill(",")],
  ["hyphens", fill("-")],
  ["slashes", fill("/")],
  ["angle brackets", fill("<")],
  ["at signs", fill("@")],
  // repeated near-matches of the patterns in these files
  ["unclosed links", fill("[a](http://")],
  ["links", fill("[a](http://b) ")],
  ["urls", fill("http://a ")],
  ["fences", fill("```")],
  ["list markers", fill("- [ ] ")],
  ["time-bound prefixes", fill("more than a a ")],
  ["time-bound words", fill("older last before days ")],
  ["ddl prefixes", fill("ALTER TABLE a ADD COLUMN ")],
  ["synthetic origins", fill("a::sql@")],
];

/**
 * `new RegExp(…)` sites whose source is built at run time, so cannot be timed
 * here. Each is listed with what it is built FROM; a site that is not listed
 * fails the test. Nothing built from request text belongs in this list.
 */
const RUNTIME_BUILT_PATTERNS: ReadonlyArray<{ file: string; text: string; builtFrom: string }> = [
  {
    file: "lib/code-graph/hybrid-search.ts",
    text: "new RegExp(`^${escaped}$`)",
    builtFrom:
      "matchGlob: a caller's file-path glob with every metacharacter escaped, tested against one file path",
  },
];

interface FoundRegex {
  file: string;
  line: number;
  source: string;
  flags: string;
}

interface Unevaluable {
  file: string;
  line: number;
  text: string;
}

/** The top-level `const NAME = <string expression>` values of a file. */
function stringConstants(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
    }
  }
  return out;
}

/** The string an expression denotes, or null when it is not a compile-time string. */
function evaluate(
  node: ts.Expression,
  constants: Map<string, ts.Expression>,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, constants, depth + 1);
  if (ts.isIdentifier(node)) {
    const init = constants.get(node.text);
    return init ? evaluate(init, constants, depth + 1) : null;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const value = evaluate(span.expression, constants, depth + 1);
      if (value === null) return null;
      text += value + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left, constants, depth + 1);
    const right = evaluate(node.right, constants, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** Every regex literal and `new RegExp(…)` / `RegExp(…)` in one file. */
export function regexesIn(file: string, code: string): { found: FoundRegex[]; bad: Unevaluable[] } {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const constants = stringConstants(sf);
  const found: FoundRegex[] = [];
  const bad: Unevaluable[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      const text = node.text;
      const close = text.lastIndexOf("/");
      found.push({
        file,
        line: lineOf(node),
        source: text.slice(1, close),
        flags: text.slice(close + 1),
      });
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp"
    ) {
      const [pattern, flagsArg] = node.arguments ?? [];
      const source = pattern ? evaluate(pattern, constants) : null;
      const flags = flagsArg ? evaluate(flagsArg, constants) : "";
      if (source === null || flags === null) {
        bad.push({ file, line: lineOf(node), text: node.getText(sf).slice(0, 120) });
      } else {
        found.push({ file, line: lineOf(node), source, flags });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { found, bad };
}

/**
 * Milliseconds for one full scan of `text`: the pattern made global and run
 * through `replace`, which tries every start position and every match — the
 * most work any of `test`, `match`, `search`, `split` or `replace` can do with it.
 */
function scanMs(regex: FoundRegex, text: string): number {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- test-only: `regex.source` is a pattern this suite extracted from the checked-in files in FUZZED_FILES, never request input; compiling it and timing it against adversarial text is the ReDoS check itself.
  const re = new RegExp(regex.source, flags);
  const start = performance.now();
  text.replace(re, "");
  return performance.now() - start;
}

/**
 * Best of up to three: a slow first run under a loaded machine is not a finding.
 * A run four times over the bound is not load, and is not repeated.
 */
function bestMs(regex: FoundRegex, text: string): number {
  let best = scanMs(regex, text);
  for (let i = 0; i < 2 && best > BOUND_MS && best < BOUND_MS * 4; i++) {
    best = Math.min(best, scanMs(regex, text));
  }
  return best;
}

/** Every input at every size, built once. */
const INPUT_TEXTS: ReadonlyArray<{ name: string; size: number; text: string }[]> =
  ADVERSARIAL_INPUTS.map(([name, build]) =>
    LADDER.map((size) => ({ name, size, text: build(size) })),
  );

/** The first input and size at which `regex` exceeds the bound; null when none does. */
function firstSlow(regex: FoundRegex): { name: string; size: number; ms: number } | null {
  for (const sizes of INPUT_TEXTS) {
    for (const { name, size, text } of sizes) {
      const ms = bestMs(regex, text);
      if (ms > BOUND_MS) return { name, size, ms };
    }
  }
  return null;
}

const collected = FUZZED_FILES.map((file) => {
  const path = resolve(SERVER_SRC, file);
  return {
    file,
    exists: existsSync(path),
    code: existsSync(path) ? readFileSync(path, "utf8") : "",
  };
}).map(({ file, exists, code }) => ({ file, exists, ...regexesIn(file, code) }));

describe("regex extraction (the fuzz below is only as good as this)", () => {
  it("finds literals, `new RegExp` with a template, and reports what it cannot evaluate", () => {
    const { found, bad } = regexesIn(
      "x.ts",
      [
        'const UNIT = "days?|weeks?";',
        "const A = /^a+$/i;",
        'const B = new RegExp(`\\\\b(${UNIT})\\\\s{1,8}old\\\\b`, "i");',
        'const C = new RegExp("a" + UNIT);',
        "function f(name: string) { return new RegExp(name); }",
        "const D = (s: string) => s.replace(/x*y/g, '');",
      ].join("\n"),
    );
    expect(found.map((r) => [r.line, r.source, r.flags])).toEqual([
      [2, "^a+$", "i"],
      [3, "\\b(days?|weeks?)\\s{1,8}old\\b", "i"],
      [4, "adays?|weeks?", ""],
      [6, "x*y", "g"],
    ]);
    expect(bad.map((b) => b.line)).toEqual([5]);
  });

  it("reads every listed file, and each one that holds a pattern yields it", () => {
    expect(collected.filter((c) => !c.exists).map((c) => c.file)).toEqual([]);
    const total = collected.reduce((n, c) => n + c.found.length, 0);
    // 100+ at the time of writing. A collapse to a handful means the walk broke.
    expect(total).toBeGreaterThan(80);
    for (const name of ["change-request.ts", "column-proposal-gate.ts", "hybrid-search.ts"]) {
      const entry = collected.find((c) => c.file.endsWith(name))!;
      expect(entry.found.length, name).toBeGreaterThan(3);
    }
  });

  it("can evaluate every `new RegExp` in the listed files, bar the reviewed run-time ones", () => {
    const unevaluated = collected.flatMap((c) => c.bad).map(({ file, text }) => ({ file, text }));
    expect(unevaluated).toEqual(RUNTIME_BUILT_PATTERNS.map(({ file, text }) => ({ file, text })));
    for (const p of RUNTIME_BUILT_PATTERNS) expect(p.builtFrom.length).toBeGreaterThan(20);
  });

  it("flags the quadratic pattern this PR shipped, on the review's input", () => {
    const shipped: FoundRegex = {
      file: "change-request.ts@b86ca7a0",
      line: 181,
      source: "^\\s*(?:\\*\\*|__)([^*_\\n]{1,120})(?:\\*\\*|__)\\s*:?\\s*$",
      flags: "",
    };
    const slow = firstSlow(shipped);
    expect(slow?.name).toBe("bold, spaces, char");
    // Caught on the way up the ladder, well before 200 KB and its 23 seconds.
    expect(slow!.size).toBeLessThan(SIZE);
  });

  it("FAILS, rather than hangs, on a cubic and on an exponential pattern", () => {
    const start = performance.now();
    // Unanchored, the shipped tail is cubic: no result at 200 KB in fifteen minutes.
    const cubic = firstSlow({ file: "x", line: 1, source: "\\s*:?\\s*$", flags: "" });
    expect(cubic).not.toBeNull();
    expect(cubic!.size).toBeLessThanOrEqual(4000);
    const exponential = firstSlow({ file: "x", line: 1, source: "^(a+)+$", flags: "" });
    expect(exponential).not.toBeNull();
    expect(exponential!.size).toBeLessThanOrEqual(32);
    expect(performance.now() - start).toBeLessThan(120_000);
  }, 180_000);
});

describe(`every pattern in the impact chain is linear on ${SIZE / 1000} KB`, () => {
  it(`covers at least 40 adversarial inputs, each ${SIZE} characters`, () => {
    expect(ADVERSARIAL_INPUTS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(ADVERSARIAL_INPUTS.map(([name]) => name)).size).toBe(ADVERSARIAL_INPUTS.length);
    expect(LADDER.at(-1)).toBe(SIZE);
    for (const sizes of INPUT_TEXTS) {
      for (const { name, size, text } of sizes) expect(text.length, `${name} @ ${size}`).toBe(size);
    }
  });

  for (const { file, found } of collected) {
    it(`${file} — ${found.length} pattern(s) × ${ADVERSARIAL_INPUTS.length} inputs, up to ${SIZE / 1000} KB, under ${BOUND_MS} ms`, () => {
      const slow: string[] = [];
      for (const regex of found) {
        const hit = firstSlow(regex);
        if (hit) {
          slow.push(
            `${file}:${regex.line} /${regex.source}/${regex.flags} on "${hit.name}" at ${hit.size} chars: ${Math.round(hit.ms)} ms`,
          );
        }
      }
      expect(slow).toEqual([]);
    }, 600_000);
  }
});
