/**
 * Phase-1 full coverage: source units, whole-unit mining, chunk planning,
 * truncation splitting and the merge of chunk replies. Pure — no model, no DB.
 *
 * Two fixtures under __fixtures__/phase1: `validate.ts.fixture` is a real file
 * from onyourleft (packages/domain/src/routing/validate.ts, Apache-2.0, no
 * personal data) with the symbol ranges the code graph recorded for it;
 * `WorkoutPlanner.kt.fixture` is synthetic (onyourleft has no Kotlin), with a
 * nested local function and validated properties outside any method.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mineTsRules } from "../code-graph/ts-rule-miner.js";
import { mineKtRules } from "../code-graph/kt-rule-miner.js";
import {
  DEFAULT_PHASE1_CHUNK_INPUT_TOKENS,
  MAX_PHASE1_SPLIT_DEPTH,
  MINER_RULE_CAP,
  PHASE1_INPUT_CHARS_PER_TOKEN,
  buildSourceUnits,
  chunkInputChars,
  chunkOutputChars,
  isTrivialLine,
  measureChunkCoverage,
  mergePhase1ChunkFacts,
  mineUnit,
  phase1ChunkLimits,
  planPhase1Chunks,
  renderUnit,
  resolvePhase1ChunkInputTokens,
  shouldSplitPhase1Chunk,
  splitPhase1Chunk,
  symbolKey,
  type Phase1Unit,
  type SymbolRange,
} from "./phase1-chunking.js";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "__fixtures__/phase1");
const TS_PATH = "packages/domain/src/routing/validate.ts";
const TS_LINES = readFileSync(path.join(FIXTURES, "validate.ts.fixture"), "utf-8").split("\n");
/** The symbols the onyourleft code graph recorded for validate.ts (dev.db). */
const TS_SYMBOLS: SymbolRange[] = [
  ["module", "", 1, 185],
  ["interface", "::RawHeight", 58, 61],
  ["interface", "::RawLeg", 50, 55],
  ["interface", "::RawPosition", 44, 47],
  ["function", "::checkedDistance", 162, 173],
  ["function", "::checkedElevation", 175, 184],
  ["function", "::checkedHeights", 121, 146],
  ["function", "::checkedLeg", 84, 104],
  ["function", "::checkedPosition", 148, 160],
  ["function", "::surfaceFrom", 115, 119],
].map(([kind, name, startLine, endLine]) => ({
  kind: kind as string,
  qualifiedName: `${TS_PATH}${name as string}`,
  filePath: TS_PATH,
  startLine: startLine as number,
  endLine: endLine as number,
}));

const KT_PATH = "app/src/main/kotlin/dev/example/workout/WorkoutPlanner.kt";
const KT_LINES = readFileSync(path.join(FIXTURES, "WorkoutPlanner.kt.fixture"), "utf-8").split(
  "\n",
);
const KT_SYMBOLS: SymbolRange[] = [
  ["class", "WorkoutPlanner", 12, 33],
  ["method", "WorkoutPlanner::plan", 16, 26],
  ["function", "WorkoutPlanner::plan::clamp", 21, 24],
  ["method", "WorkoutPlanner::zoneOf", 28, 32],
  ["function", "describe", 35, 38],
].map(([kind, name, startLine, endLine]) => ({
  kind: kind as string,
  qualifiedName: `${KT_PATH}::${name as string}`,
  filePath: KT_PATH,
  startLine: startLine as number,
  endLine: endLine as number,
}));

function minedUnits(filePath: string, lines: string[], symbols: SymbolRange[]): Phase1Unit[] {
  return buildSourceUnits(filePath, lines, symbols).map((u) => mineUnit(u, symbols));
}

// ============================================================================
// Units
// ============================================================================

describe("buildSourceUnits", () => {
  it("covers every non-trivial line of a real file exactly once, module-level code included", () => {
    const units = buildSourceUnits(TS_PATH, TS_LINES, TS_SYMBOLS);
    const seen = new Map<number, number>();
    for (const u of units) {
      for (let l = u.startLine; l <= u.endLine; l++) seen.set(l, (seen.get(l) ?? 0) + 1);
    }
    for (let l = 1; l <= TS_LINES.length; l++) {
      if (isTrivialLine(TS_LINES[l - 1])) continue;
      expect(seen.get(l), `line ${l}`).toBe(1);
    }
    // The constants and interfaces are module-level: no function symbol covers them.
    const moduleLevel = units
      .filter((u) => u.kind === "module-level")
      .map((u) => u.text)
      .join("\n");
    expect(moduleLevel).toContain("export const MINIMUM_LEG_POINTS = 2;");
    expect(moduleLevel).toContain("export const MAXIMUM_LEG_POINTS = 20_000;");
    expect(moduleLevel).toContain("export interface RawLeg");
    // Every function is in exactly one unit.
    const fnKeys = TS_SYMBOLS.filter((s) => s.kind === "function").map(symbolKey);
    const inUnits = units.flatMap((u) => u.symbols);
    expect(inUnits.sort()).toEqual(fnKeys.sort());
  });

  it("reads a nested function inside its parent, never twice", () => {
    const units = buildSourceUnits(KT_PATH, KT_LINES, KT_SYMBOLS);
    const plan = units.find((u) => u.label.endsWith("::plan"))!;
    expect(plan.startLine).toBe(16);
    expect(plan.endLine).toBe(26);
    expect(plan.symbols).toHaveLength(2);
    expect(units.filter((u) => u.text.includes("fun clamp"))).toHaveLength(1);
    // The validated constructor properties sit in the class but in no method.
    const moduleLevel = units
      .filter((u) => u.kind === "module-level")
      .map((u) => u.text)
      .join("\n");
    expect(moduleLevel).toContain("@field:Min(1) @field:Max(240) val durationMinutes: Int");
    expect(moduleLevel).toContain("const val MAX_INTERVALS = 64");
  });

  it("clamps ranges past the end of the file and drops all-trivial gaps", () => {
    const lines = ["function a() {", "  return 1;", "}", "", "}", ""];
    const units = buildSourceUnits("x.ts", lines, [
      { kind: "function", qualifiedName: "a", filePath: "x.ts", startLine: 1, endLine: 3 },
      { kind: "function", qualifiedName: "ghost", filePath: "x.ts", startLine: 99, endLine: 120 },
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].symbols).toEqual(["x.ts:1:a"]);
    expect(buildSourceUnits("empty.ts", [], [])).toEqual([]);
  });

  it("renders a whole function with the header the budgeted loop used", () => {
    const [u] = buildSourceUnits(TS_PATH, TS_LINES, TS_SYMBOLS).filter((x) =>
      x.label.endsWith("::surfaceFrom"),
    );
    expect(renderUnit(u).split("\n")[0]).toBe(`// ${TS_PATH}::surfaceFrom`);
  });
});

// ============================================================================
// Mining over whole units
// ============================================================================

describe("mineUnit over whole files", () => {
  it("TS: every rule once, at its real file line, the module-level constants included", () => {
    const units = minedUnits(TS_PATH, TS_LINES, TS_SYMBOLS);
    const rules = units.flatMap((u) => u.rules);
    const keys = rules.map((r) => `${r.line}|${r.kind}|${r.expression}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The line number points at the text the rule was mined from.
    for (const r of rules) {
      const lineText = TS_LINES[r.line - 1].replace(/\s+/g, " ").trim();
      expect(lineText.startsWith(r.expression.replace(/…$/, "").slice(0, 20)), `L${r.line}`).toBe(
        true,
      );
    }
    // Same rules as mining the whole file in one pass (the input contract holds).
    const whole = mineTsRules(TS_LINES.join("\n"), TS_PATH, 1, null);
    expect(keys.sort()).toEqual(whole.map((r) => `${r.line}|${r.kind}|${r.expression}`).sort());
    // Module-level constants: the budgeted loop never read these lines.
    const consts = rules.filter((r) => r.kind === "const").map((r) => r.line);
    // `MINIMUM_LEG_POINTS = 2` (line 71) is a module-level constant.
    expect(consts).toContain(71);
    expect(rules.find((r) => r.line === 71)!.context).toBeNull();
    // A rule inside a function names it.
    expect(rules.find((r) => r.line === 85)!.context).toBe(`${TS_PATH}::checkedLeg`);
  });

  it("TS: finds more rules than the old per-method slices, which skipped module-level code", () => {
    const oldRules = TS_SYMBOLS.filter((s) => s.kind === "function").flatMap((s) =>
      mineTsRules(
        TS_LINES.slice(s.startLine - 1, s.endLine).join("\n"),
        TS_PATH,
        s.startLine,
        s.qualifiedName,
      ),
    );
    const newRules = minedUnits(TS_PATH, TS_LINES, TS_SYMBOLS).flatMap((u) => u.rules);
    expect(newRules.length).toBeGreaterThan(oldRules.length);
    const newKeys = new Set(newRules.map((r) => `${r.line}|${r.kind}`));
    for (const r of oldRules) expect(newKeys.has(`${r.line}|${r.kind}`)).toBe(true);
  });

  it("Kotlin: a nested function's rules are not duplicated, and property annotations are mined", () => {
    const rules = minedUnits(KT_PATH, KT_LINES, KT_SYMBOLS).flatMap((u) => u.rules);
    const keys = rules.map((r) => `${r.line}|${r.kind}|${r.expression}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The old loop sliced `plan` AND its nested `clamp`, mining line 22 twice.
    const oldLine22 = ["plan", "plan::clamp"]
      .flatMap((n) => {
        const s = KT_SYMBOLS.find((x) => x.qualifiedName.endsWith(`::${n}`))!;
        return mineKtRules(
          KT_LINES.slice(s.startLine - 1, s.endLine).join("\n"),
          KT_PATH,
          s.startLine,
          null,
        );
      })
      .filter((r) => r.line === 22);
    expect(oldLine22.length).toBeGreaterThan(rules.filter((r) => r.line === 22).length);
    // The innermost function is the rule's context.
    expect(
      rules.filter((r) => r.line === 22).every((r) => r.context?.endsWith("::plan::clamp")),
    ).toBe(true);
    // Rules outside any method: validation annotations and constants.
    expect(rules.some((r) => r.line === 13 && r.context === null)).toBe(true);
    expect(rules.some((r) => r.line === 9 && r.kind === "const")).toBe(true);
    // Every rule points at its own line.
    for (const r of rules) expect(r.line).toBeGreaterThan(0);
    expect(rules.every((r) => r.line <= KT_LINES.length)).toBe(true);
  });

  it("re-mines a unit that reaches the miner's rule cap in windows, losing nothing", () => {
    const n = MINER_RULE_CAP + 150;
    const lines = Array.from({ length: n }, (_, i) => `export const LIMIT_${i} = ${i};`);
    const [u] = minedUnits("big.ts", lines, []);
    expect(u.rules).toHaveLength(n);
    expect(new Set(u.rules.map((r) => r.line)).size).toBe(n);
    expect(u.rules.every((r) => lines[r.line - 1].includes(r.expression.slice(0, 18)))).toBe(true);
  });

  it("shifts formula line numbers to file lines", () => {
    const formulas = minedUnits(TS_PATH, TS_LINES, TS_SYMBOLS).flatMap((u) => u.formulas);
    expect(formulas.length).toBeGreaterThan(0);
    for (const f of formulas) {
      const text = TS_LINES[f.startLine - 1].replace(/\s+/g, " ");
      expect(text, `formula at ${f.startLine}`).toContain(
        f.expression.replace(/\s+/g, " ").slice(0, 12),
      );
    }
    // At least one formula lives past the first function, where slice-relative numbering would be wrong.
    expect(formulas.some((f) => f.startLine > 84)).toBe(true);
  });
});

// ============================================================================
// Chunk planning
// ============================================================================

/** A synthetic module far bigger than the old 80-method / 60K-char budgets. */
function syntheticModule(files: number, fnsPerFile: number, linesPerFn: number) {
  const symbols: SymbolRange[] = [];
  const units: Phase1Unit[] = [];
  const moduleLevelLines: Array<[string, number]> = [];
  for (let f = 0; f < files; f++) {
    const filePath = `src/big/file${f}.ts`;
    const lines: string[] = [`export const FILE_${f}_LIMIT = ${f};`, ""];
    moduleLevelLines.push([filePath, 1]);
    for (let i = 0; i < fnsPerFile; i++) {
      const start = lines.length + 1;
      lines.push(`export function f${f}_${i}(x: number) {`);
      for (let k = 0; k < linesPerFn - 2; k++) {
        lines.push(
          k % 7 === 0 ? `  if (x > ${k}) throw new Error("too big ${k}");` : `  x = x * ${k};`,
        );
      }
      lines.push("}");
      symbols.push({
        kind: "function",
        qualifiedName: `${filePath}::f${f}_${i}`,
        filePath,
        startLine: start,
        endLine: lines.length,
      });
      lines.push(`export const SCHEMA_${f}_${i} = { max: ${i} };`);
      moduleLevelLines.push([filePath, lines.length]);
    }
    units.push(...minedUnits(filePath, lines, symbols));
  }
  return { symbols, units, moduleLevelLines };
}

describe("planPhase1Chunks", () => {
  const limits = phase1ChunkLimits(16_384);

  it("puts 100% of functions and module-level lines of a huge module in exactly one chunk each", () => {
    // 40 files x 30 functions x 60 lines = 1,200 functions, ~2 MB: 15x the old
    // 80-method cap and ~30x the old 60K-char budget.
    const { symbols, units, moduleLevelLines } = syntheticModule(40, 30, 60);
    const chunks = planPhase1Chunks(units, limits);
    const coverage = measureChunkCoverage(chunks, symbols, 0);
    expect(coverage.functionsTotal).toBe(1_200);
    expect(coverage.functionsIncluded).toBe(1_200);
    const placed = new Map<string, number>();
    for (const chunk of chunks) {
      for (const u of chunk) {
        for (let l = u.startLine; l <= u.endLine; l++) {
          const k = `${u.filePath}:${l}`;
          placed.set(k, (placed.get(k) ?? 0) + 1);
        }
      }
    }
    for (const [fp, line] of moduleLevelLines)
      expect(placed.get(`${fp}:${line}`), `${fp}:${line}`).toBe(1);
    expect([...placed.values()].every((n) => n === 1)).toBe(true);
    // Every symbol key appears in exactly one chunk.
    const keys = chunks.flatMap((c) => c.flatMap((u) => u.symbols));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps every chunk inside its input and estimated-output budgets", () => {
    const { units } = syntheticModule(20, 20, 60);
    const chunks = planPhase1Chunks(units, limits);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(chunkInputChars(c)).toBeLessThanOrEqual(limits.inputChars);
      expect(chunkOutputChars(c)).toBeLessThanOrEqual(limits.outputChars);
    }
  });

  it("sizes chunks by output: a smaller cap plans more chunks over the same code", () => {
    const { units } = syntheticModule(10, 20, 60);
    expect(planPhase1Chunks(units, phase1ChunkLimits(8_192)).length).toBeGreaterThan(
      planPhase1Chunks(units, phase1ChunkLimits(16_384)).length,
    );
  });

  it("keeps a file's code in one chunk when the file fits one", () => {
    // Files of ~6K chars each: several fit a chunk, none is split across two.
    const { units } = syntheticModule(12, 3, 60);
    const chunks = planPhase1Chunks(units, limits);
    const chunkOfFile = new Map<string, Set<number>>();
    chunks.forEach((c, i) => {
      for (const u of c) {
        if (!chunkOfFile.has(u.filePath)) chunkOfFile.set(u.filePath, new Set());
        chunkOfFile.get(u.filePath)!.add(i);
      }
    });
    for (const [fp, set] of chunkOfFile) expect(set.size, fp).toBe(1);
    expect(chunks.length).toBeLessThan(12);
  });

  it("a single file too big for one chunk is packed across chunks in line order", () => {
    const { units } = syntheticModule(1, 200, 60);
    const chunks = planPhase1Chunks(units, limits);
    expect(chunks.length).toBeGreaterThan(1);
    const starts = chunks.flatMap((c) => c.map((u) => u.startLine));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("cuts a unit too big for one call into line ranges, keeping every line and rule once", () => {
    const lines = Array.from(
      { length: 4_000 },
      (_, k) => `  if (x > ${k}) throw new Error("e${k}");`,
    );
    lines.unshift("export function giant(x: number) {");
    lines.push("}");
    const symbols = [
      {
        kind: "function",
        qualifiedName: "giant",
        filePath: "g.ts",
        startLine: 1,
        endLine: lines.length,
      },
    ];
    const units = minedUnits("g.ts", lines, symbols);
    const chunks = planPhase1Chunks(units, limits);
    expect(chunks.length).toBeGreaterThan(1);
    const pieces = chunks.flat();
    expect(pieces.every((p) => p.partOf?.startLine === 1)).toBe(true);
    expect(pieces.reduce((n, p) => n + (p.endLine - p.startLine + 1), 0)).toBe(lines.length);
    expect(pieces.reduce((n, p) => n + p.rules.length, 0)).toBe(units[0].rules.length);
    // The function is counted once, by its first piece.
    expect(pieces.flatMap((p) => p.symbols)).toEqual(["g.ts:1:giant"]);
    expect(renderUnit(pieces[1]).split("\n")[0]).toMatch(
      /^\/\/ giant \(lines \d+-\d+ of 1-4002\)$/,
    );
    // The mined inventory of every chunk renders without truncation.
    for (const c of chunks) {
      const chars = c
        .flatMap((u) => u.rules)
        .reduce((n, r) => n + `- L${r.line}: ${r.summary}`.length, 0);
      expect(chars).toBeLessThanOrEqual(limits.minedChars);
    }
  });

  it("plans nothing for nothing", () => {
    expect(planPhase1Chunks([], limits)).toEqual([]);
  });
});

describe("phase1ChunkLimits / input budget", () => {
  it("converts the input-token budget at the measured chars/token for code", () => {
    expect(PHASE1_INPUT_CHARS_PER_TOKEN).toBe(3.5);
    expect(phase1ChunkLimits(16_384).inputChars).toBe(DEFAULT_PHASE1_CHUNK_INPUT_TOKENS * 3.5);
    expect(phase1ChunkLimits(16_384, 10_000).inputChars).toBe(35_000);
    expect(phase1ChunkLimits(16_384).outputChars).toBe(Math.floor(16_384 * 3.5 * 0.6));
  });

  it("reads the budget from config, falling back on nonsense", () => {
    const config = (v: number) => ({ getNumber: () => v }) as never;
    expect(resolvePhase1ChunkInputTokens(config(30_000))).toBe(30_000);
    expect(resolvePhase1ChunkInputTokens(config(12))).toBe(DEFAULT_PHASE1_CHUNK_INPUT_TOKENS);
    expect(resolvePhase1ChunkInputTokens(config(Number.NaN))).toBe(
      DEFAULT_PHASE1_CHUNK_INPUT_TOKENS,
    );
  });
});

// ============================================================================
// Truncation → split
// ============================================================================

describe("splitting a cut-off chunk", () => {
  const limits = phase1ChunkLimits(16_384);

  it("halves a multi-unit chunk, and a single unit by lines, until a single line", () => {
    const { units } = syntheticModule(1, 8, 60);
    const [a, b] = splitPhase1Chunk(units)!;
    expect([...a, ...b]).toEqual(units);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    const one = units.filter((u) => u.kind === "symbol").slice(0, 1);
    const [l, r] = splitPhase1Chunk(one)!;
    expect(l[0].endLine + 1).toBe(r[0].startLine);
    const oneLine = { ...one[0], endLine: one[0].startLine };
    expect(splitPhase1Chunk([oneLine])).toBeNull();
    expect(splitPhase1Chunk([])).toBeNull();
  });

  it("is bounded: never past MAX_PHASE1_SPLIT_DEPTH, and never a chunk too small to explain the cut-off", () => {
    const { units } = syntheticModule(4, 30, 60);
    const [big] = planPhase1Chunks(units, limits);
    expect(shouldSplitPhase1Chunk(big, 0, limits)).toBe(true);
    expect(shouldSplitPhase1Chunk(big, MAX_PHASE1_SPLIT_DEPTH, limits)).toBe(false);
    // A tiny chunk that runs to the cap is a runaway, not a size problem.
    const tiny = minedUnits(
      "t.ts",
      ["export function t() {", "  return 1;", "}"],
      [{ kind: "function", qualifiedName: "t", filePath: "t.ts", startLine: 1, endLine: 3 }],
    );
    expect(shouldSplitPhase1Chunk(tiny, 0, limits)).toBe(false);
    // Simulate a model that is always cut off: the recursion terminates and
    // costs at most 2^(depth+1)-1 calls per planned chunk.
    let calls = 0;
    const extract = (chunk: Phase1Unit[], depth: number): void => {
      calls += 1;
      if (shouldSplitPhase1Chunk(chunk, depth, limits)) {
        const [x, y] = splitPhase1Chunk(chunk)!;
        extract(x, depth + 1);
        extract(y, depth + 1);
      }
    };
    extract(big, 0);
    expect(calls).toBeLessThanOrEqual(2 ** (MAX_PHASE1_SPLIT_DEPTH + 1) - 1);
    expect(calls).toBeGreaterThan(1);
  });
});

// ============================================================================
// Merge
// ============================================================================

describe("mergePhase1ChunkFacts", () => {
  it("returns a single reply unchanged", () => {
    const reply = "PURPOSE\nx\n\nRULES\n- a\n- a";
    expect(mergePhase1ChunkFacts([reply])).toBe(reply);
  });

  it("merges by section in prompt order, keeping each identical fact once", () => {
    const merged = mergePhase1ChunkFacts([
      "PURPOSE\nPart one.\n\nRULES\n- Amount must be positive\n  - rejected otherwise\n- Currency is ISO\n\nNOTES\n(none)",
      "## RULES\n- Amount must be positive\n  - rejected otherwise\n- Refunds need a reason\n\n**ENTITIES**\n- `Refund` — money back\n\nPURPOSE\nPart two.",
    ]);
    expect(merged).toBe(
      [
        "PURPOSE\nPart one.\nPart two.",
        "ENTITIES\n- `Refund` — money back",
        "RULES\n- Amount must be positive\n  - rejected otherwise\n- Currency is ISO\n- Refunds need a reason",
      ].join("\n\n"),
    );
  });

  it("does not collapse facts that only share a sub-line", () => {
    const merged = mergePhase1ChunkFacts([
      "RULES\n- Rule A\n  - Consequence: rejected",
      "RULES\n- Rule B\n  - Consequence: rejected",
    ]);
    expect(merged.match(/Consequence: rejected/g)).toHaveLength(2);
  });

  it("keeps text written before any heading, and DATA_LINEAGE after the prompt's headings", () => {
    const merged = mergePhase1ChunkFacts([
      "The model ignored the format.",
      "DATA_LINEAGE\n- reads a\n\nRULES: - inline rule",
    ]);
    expect(merged).toBe(
      "PURPOSE\nThe model ignored the format.\n\nRULES\n- inline rule\n\nDATA_LINEAGE\n- reads a",
    );
  });
});
