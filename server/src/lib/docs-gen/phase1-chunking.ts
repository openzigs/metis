/**
 * Phase-1 full-coverage source assembly, deterministic mining and chunk
 * planning.
 *
 * Phase 1 used to read a module through a budget: methods sorted by size and
 * capped at 25/50/80, snippets gathered until 18K/36K/60K chars, each method cut
 * at 300 lines, the joined snippets sliced again at 60K chars — and the rule
 * miners ran inside that same loop, so a function past the budget was neither
 * read by the model nor mined. Module-level code (top-level constants, zod
 * schemas, config objects) was never read at all. On onyourleft (143 modules)
 * roughly 45% of 4,267 functions were never read or mined.
 *
 * This module replaces the budget with three pure steps:
 *
 *   1. {@link buildSourceUnits} — a file is partitioned into non-overlapping
 *      units: each OUTERMOST function/method body (nested ones travel inside
 *      their parent) and each run of module-level code between them. Every
 *      line of the file is in exactly one unit, except runs of blank or pure
 *      punctuation lines (`}`, `});`) that carry nothing to read.
 *   2. {@link mineUnit} — every language miner runs over every unit, in full,
 *      independent of any LLM budget. Units never overlap, so a rule cannot be
 *      mined twice; results are still de-duplicated by file+line+kind+expression
 *      (a miner-cap re-mine in overlapping windows can repeat one).
 *   3. {@link planPhase1Chunks} — units are packed into chunks that respect an
 *      INPUT budget and an estimated OUTPUT budget (the per-call output cap from
 *      `output-caps.ts`, sized like `section-batching.ts`), keeping a file's code
 *      together where it fits. One Phase-1 call is made per chunk, so no code
 *      is dropped: a module larger than one call is simply more calls.
 *
 * No I/O and no model: the caller reads files and talks to the provider.
 */
import { extractFormulas, type ExtractedFormula } from "../code-graph/formula-extractor.js";
import { mineJavaRules } from "../code-graph/java-rule-miner.js";
import {
  mineSasRules,
  mineSasWorkflow,
  renderSasDataLineage,
  renderSasWorkflow,
  type MinedSasStep,
} from "../code-graph/sas-rule-miner.js";
import { minePyRules } from "../code-graph/py-rule-miner.js";
import { mineGoRules } from "../code-graph/go-rule-miner.js";
import { mineTsRules } from "../code-graph/ts-rule-miner.js";
import { mineCsRules } from "../code-graph/cs-rule-miner.js";
import { mineKtRules } from "../code-graph/kt-rule-miner.js";
import { mineSqlRules } from "../code-graph/sql-rule-miner.js";
import { detectLanguage } from "../code-graph/parsers.js";
import { toPersistedMinedRules, type PersistedMinedRule } from "./fact-slices.js";
import { BATCH_OUTPUT_MARGIN, CHARS_PER_OUTPUT_TOKEN } from "./section-batching.js";
import { getConfigService, type ConfigService } from "../config/config-service.js";

// ============================================================================
// 1. Source units
// ============================================================================

/** The fields of a code symbol this module reads. */
export interface SymbolRange {
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Identity of one symbol for coverage accounting. Qualified names alone are not
 * unique (overloads, re-declared helpers), so the start line is part of it.
 */
export function symbolKey(s: SymbolRange): string {
  return `${s.filePath}:${s.startLine}:${s.qualifiedName}`;
}

/** Symbol kinds whose body is read as a unit (the old loop read exactly these). */
export function isCallableSymbol(s: { kind: string }): boolean {
  return s.kind === "method" || s.kind === "function";
}

/** One contiguous, non-overlapping slice of a source file. */
export interface SourceUnit {
  filePath: string;
  /** A function/method body, or module-level code between them. */
  kind: "symbol" | "module-level";
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** The outermost symbol's qualified name, or the file path for module-level code. */
  label: string;
  /** {@link symbolKey} of every callable symbol whose body lies in this unit (outermost first). */
  symbols: string[];
  /** The unit's lines, verbatim. */
  text: string;
  /**
   * A unit that carries only mined rules (a `.sql` file's inventory): no source
   * is rendered for it, but its rules are chunked like any other unit's.
   */
  inventoryOnly?: boolean;
  /**
   * Set when an oversized unit was cut into line ranges: the range of the
   * whole unit this piece came from (so the model is told it is reading part
   * of a function).
   */
  partOf?: { startLine: number; endLine: number };
}

/** A line with nothing to read: blank, or only braces/brackets/parens/semicolons/commas. */
const TRIVIAL_LINE = /^[\s{}()[\];,]*$/;

/** True for a line {@link buildSourceUnits} may leave out of every unit. */
export function isTrivialLine(line: string): boolean {
  return TRIVIAL_LINE.test(line);
}

/**
 * Partition one file into {@link SourceUnit}s, in line order.
 *
 * Callable ranges are clamped to the file (a stale graph can point past its
 * end), sorted, and merged when they overlap, so a nested function is read
 * inside its parent rather than twice. The gaps between them are module-level
 * units, trimmed of trivial lines at both ends and dropped when entirely
 * trivial.
 */
export function buildSourceUnits(
  filePath: string,
  lines: readonly string[],
  symbols: readonly SymbolRange[],
): SourceUnit[] {
  const n = lines.length;
  if (n === 0) return [];
  const callables = symbols
    .filter((s) => s.filePath === filePath && isCallableSymbol(s) && s.startLine <= n)
    .map((s) => {
      const start = Math.max(1, s.startLine);
      return { s, start, end: Math.min(n, Math.max(start, s.endLine)) };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const spans: Array<{ start: number; end: number; label: string; symbols: string[] }> = [];
  for (const c of callables) {
    const last = spans[spans.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      last.symbols.push(symbolKey(c.s));
      continue;
    }
    spans.push({
      start: c.start,
      end: c.end,
      label: c.s.qualifiedName,
      symbols: [symbolKey(c.s)],
    });
  }

  const units: SourceUnit[] = [];
  const pushGap = (from: number, to: number): void => {
    let a = from;
    let b = to;
    while (a <= b && isTrivialLine(lines[a - 1])) a++;
    while (b >= a && isTrivialLine(lines[b - 1])) b--;
    if (a > b) return;
    units.push({
      filePath,
      kind: "module-level",
      startLine: a,
      endLine: b,
      label: filePath,
      symbols: [],
      text: lines.slice(a - 1, b).join("\n"),
    });
  };
  let cursor = 1;
  for (const sp of spans) {
    if (sp.start > cursor) pushGap(cursor, sp.start - 1);
    units.push({
      filePath,
      kind: "symbol",
      startLine: sp.start,
      endLine: sp.end,
      label: sp.label,
      symbols: sp.symbols,
      text: lines.slice(sp.start - 1, sp.end).join("\n"),
    });
    cursor = sp.end + 1;
  }
  if (cursor <= n) pushGap(cursor, n);
  return units;
}

/**
 * The unit as the Phase-1 prompt shows it. A whole function keeps the exact
 * `// qualifiedName` header the budgeted loop used, so a small module's prompt
 * reads as before.
 */
export function renderUnit(u: SourceUnit): string {
  const range = `lines ${u.startLine}-${u.endLine}`;
  const head =
    u.kind === "symbol"
      ? `// ${u.label}${u.partOf ? ` (${range} of ${u.partOf.startLine}-${u.partOf.endLine})` : ""}`
      : `// ${u.filePath} — module-level code (${range})`;
  return `${head}\n${u.text}`;
}

/** Separator between rendered units in the prompt (unchanged from the budgeted loop). */
export const UNIT_SEPARATOR = "\n\n---\n\n";

// ============================================================================
// 2. Deterministic mining
// ============================================================================

/**
 * The line-local miners (TS/JS, Python, Go, C#, Kotlin, SQL) stop at a per-call
 * rule cap (400, or 500 for SQL) by default. Phase 1 mines whole files and must
 * not lose a rule past it, so it calls every capped miner with no cap at all
 * (`maxRules = Infinity`) — one pass over the whole unit, so a multi-line rule
 * (a 40-case `switch`, a `z.object({...})`, a CREATE TABLE) is never cut at a
 * window edge. The Java and SAS miners have no cap.
 */
const UNCAPPED = Number.POSITIVE_INFINITY;

/** A unit with everything mined from it. */
export interface Phase1Unit extends SourceUnit {
  rules: PersistedMinedRule[];
  formulas: ExtractedFormula[];
  sasSteps: MinedSasStep[];
  /**
   * Lines with a part the formula extractor was not run on: a run longer than
   * {@link FORMULA_LINE_CHAR_LIMIT} with no `;`, `{`, `}` or `,` to split it at
   * (embedded data, long literals). Counted, logged and warned about — never
   * silent. Their rules are still mined.
   */
  formulaLinesSkipped?: number;
}

/**
 * Longest line the formula extractor is given. Its regexes backtrack
 * quadratically on a pathological single line (a crafted 1 MB line took ~295 s),
 * so a longer line is split into parts no longer than this
 * ({@link splitLongLine}), which keeps the worst case linear in the line's
 * length without losing the formulas of minified-but-meaningful code (#191).
 */
export const FORMULA_LINE_CHAR_LIMIT = 10_000;

/** `text` cut after every character in `delimiters`, delimiters kept. Linear. */
function splitAfter(text: string, delimiters: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (delimiters.includes(text[i])) {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/**
 * How a line must START for any formula-extractor pattern to match it: every
 * pattern is anchored at the line start and is either `if …` (a validation or
 * business rule) or up to a few keywords, a name, an optional `: Type`, then
 * `=` / `:=` (a constant or calculation). Tested on a bounded head only.
 */
const FORMULA_HEAD = /^\s*(?:if\b|(?:[\w$]+\s+){0,6}[\w$]+\s*(?::\s*[\w$]+\s*)?:?=)/;
const FORMULA_HEAD_CHARS = 512;

/**
 * Whether the extractor could find a formula in `part`: false when its first
 * {@link FORMULA_HEAD_CHARS} characters do not start the way every pattern
 * needs — a base64 source map or an embedded data string. (A formula whose
 * keywords and name alone run past 512 characters is not code anyone wrote.)
 */
function couldHoldFormula(part: string): boolean {
  return FORMULA_HEAD.test(part.slice(0, FORMULA_HEAD_CHARS));
}

/**
 * #191 — an over-long line as parts the formula extractor can read, each at
 * most `limit` characters: cut after every statement end (`;`) and block
 * brace (`{`, `}`) — so `function f(){if(a > b){` reads as the formatted
 * code's `if (a > b) {` line would — and, only for a part still too long,
 * after every `,` (the comma is
 * a separator, so it is dropped). A part that is still too long has nothing to
 * split at (embedded data, a long literal) and is left out; `skipped` counts
 * those of them that could hold a formula at all — a base64 source map or a
 * data blob cannot, so leaving it out loses nothing and is not reported
 * (a vendored minified bundle does not degrade the document for it). Every
 * cut is a linear scan, and each part is bounded, so
 * extraction over the parts is linear in the line's length.
 */
export function splitLongLine(
  line: string,
  limit: number = FORMULA_LINE_CHAR_LIMIT,
): { parts: string[]; skipped: number } {
  const parts: string[] = [];
  let skipped = 0;
  for (const statement of splitAfter(line, ";{}")) {
    if (statement.length <= limit) {
      parts.push(statement);
      continue;
    }
    for (const item of splitAfter(statement, ",")) {
      const part = item.endsWith(",") ? item.slice(0, -1) : item;
      if (part.length <= limit) parts.push(part);
      else if (couldHoldFormula(part)) skipped += 1;
    }
  }
  return { parts, skipped };
}

function mineRulesIn(
  text: string,
  filePath: string,
  baseLine: number,
  context: string | null,
): PersistedMinedRule[] {
  switch (detectLanguage(filePath)) {
    case "java":
      return toPersistedMinedRules("java", mineJavaRules(text, filePath, baseLine, context));
    case "ts":
      return toPersistedMinedRules("ts", mineTsRules(text, filePath, baseLine, context, UNCAPPED));
    case "js":
      return toPersistedMinedRules("js", mineTsRules(text, filePath, baseLine, context, UNCAPPED));
    case "py":
      return toPersistedMinedRules("py", minePyRules(text, filePath, baseLine, context, UNCAPPED));
    case "go":
      return toPersistedMinedRules("go", mineGoRules(text, filePath, baseLine, context, UNCAPPED));
    case "cs":
      return toPersistedMinedRules("cs", mineCsRules(text, filePath, baseLine, context, UNCAPPED));
    case "kt":
      return toPersistedMinedRules("kt", mineKtRules(text, filePath, baseLine, context, UNCAPPED));
    case "sas":
      return toPersistedMinedRules("sas", mineSasRules(text, filePath, baseLine, context));
    default:
      return [];
  }
}

/**
 * Every rule of one `.sql` file, mined in full at the file level (context = the
 * file path), uncapped — the SQL miner stops at 500 by default.
 */
export function mineSqlFile(source: string, relPath: string): PersistedMinedRule[] {
  return dedupeMinedRules(
    toPersistedMinedRules("sql", mineSqlRules(source, relPath, 1, relPath, UNCAPPED)),
  );
}

/** Identity used to de-duplicate mined rules. */
export function minedRuleKey(r: PersistedMinedRule): string {
  return JSON.stringify([r.file, r.line, r.kind, r.expression]);
}

/** `rules` without repeats of the same file+line+kind+expression, in order. */
export function dedupeMinedRules(rules: readonly PersistedMinedRule[]): PersistedMinedRule[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const key = minedRuleKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The innermost callable of `symbols` whose range holds `line` of `filePath`. */
export function innermostCallableAt(
  symbols: readonly SymbolRange[],
  filePath: string,
  line: number,
): string | null {
  let best: SymbolRange | null = null;
  for (const s of symbols) {
    if (s.filePath !== filePath || !isCallableSymbol(s)) continue;
    if (line < s.startLine || line > s.endLine) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
  }
  return best?.qualifiedName ?? null;
}

/**
 * Run every applicable miner over the WHOLE unit, with file line numbers.
 *
 * Rule `context` is the innermost callable holding the rule's line (what the
 * old per-method loop passed), or null for module-level code. Capped miners
 * are called uncapped (see {@link UNCAPPED}), so the result is complete.
 */
export function mineUnit(unit: SourceUnit, symbols: readonly SymbolRange[]): Phase1Unit {
  const { filePath, startLine, text } = unit;
  const lang = detectLanguage(filePath);
  // Only this file's callables, once per unit (the rule-context lookups below
  // would otherwise scan every module symbol per rule).
  const fileSymbols = symbols.filter((sym) => sym.filePath === filePath && isCallableSymbol(sym));
  const rules = dedupeMinedRules(mineRulesIn(text, filePath, startLine, null)).map((r) => ({
    ...r,
    context: innermostCallableAt(fileSymbols, filePath, r.line),
  }));
  // The formula extractor numbers lines from the start of what it is given;
  // shift them to file lines (the budgeted loop reported slice-relative ones).
  // #191 — an over-long line is given to the extractor as its parts, one per
  // line; `lineOf` maps each of those lines back to the unit line it came from.
  let formulaLinesSkipped = 0;
  let formulaText = text;
  let lineOf: number[] | null = null;
  if (text.length > FORMULA_LINE_CHAR_LIMIT) {
    const sourceLines = text.split("\n");
    if (sourceLines.some((line) => line.length > FORMULA_LINE_CHAR_LIMIT)) {
      const extractorLines: string[] = [];
      const origin: number[] = [];
      sourceLines.forEach((line, i) => {
        if (line.length <= FORMULA_LINE_CHAR_LIMIT) {
          extractorLines.push(line);
          origin.push(i + 1);
          return;
        }
        const { parts, skipped } = splitLongLine(line);
        if (skipped > 0) formulaLinesSkipped += 1;
        for (const part of parts) {
          extractorLines.push(part);
          origin.push(i + 1);
        }
      });
      formulaText = extractorLines.join("\n");
      lineOf = origin;
    }
  }
  const unitLine = (extractorLine: number): number =>
    (lineOf ? (lineOf[extractorLine - 1] ?? lineOf[lineOf.length - 1] ?? 1) : extractorLine) +
    startLine -
    1;
  const formulas = lang
    ? extractFormulas(formulaText, filePath, lang).map((f) => ({
        ...f,
        startLine: unitLine(f.startLine),
        endLine: unitLine(f.endLine),
        symbolContext:
          f.symbolContext ?? innermostCallableAt(fileSymbols, filePath, unitLine(f.startLine)),
      }))
    : [];
  const sasSteps = lang === "sas" ? mineSasWorkflow(text, filePath, startLine).steps : [];
  return {
    ...unit,
    rules,
    formulas,
    sasSteps,
    ...(formulaLinesSkipped > 0 ? { formulaLinesSkipped } : {}),
  };
}

// ============================================================================
// 3. Chunk planning
// ============================================================================

/**
 * Estimated Phase-1 OUTPUT characters per character of source read. Measured on
 * onyourleft's promptVersion-4 cache (133 modules, laguna-s-2.1): 453,272
 * output tokens for ~521K tokens of prompt beyond the fixed instructions — 0.87
 * tokens out per token in, ≈1.0 in characters (code ≈3.5 chars/token, facts
 * ≈4.0). The margin in {@link BATCH_OUTPUT_MARGIN} absorbs the modules that
 * write more (a test file wrote ~2x); a chunk that still runs to the cap is
 * split (see {@link splitPhase1Chunk}).
 */
export const PHASE1_OUTPUT_CHARS_PER_SOURCE_CHAR = 1.0;
/**
 * Every mined SAS DATA/PROC step becomes a WORKFLOWS step and a lineage line.
 * Steps are rendered in full (no 6,000/4,000-char cap), so the planner budgets
 * them like mined rules.
 */
export const PHASE1_OUTPUT_CHARS_PER_SAS_STEP = 200;
/** Every mined rule must come back as a RULES bullet. */
export const PHASE1_OUTPUT_CHARS_PER_MINED_RULE = 150;
/**
 * Fixed output per call regardless of size: headings, PURPOSE, KEY_APIS
 * boilerplate. Small modules on the same cache wrote ~1,300-1,600 tokens from
 * almost no source.
 */
export const PHASE1_OUTPUT_CHARS_PER_CHUNK = 5_000;
/**
 * Characters per INPUT token assumed when turning the input-token budget into
 * characters. Measured with laguna-s-2.1's own tokenizer on the Ollama host:
 * 3.66–3.95 chars/token for TypeScript, 3.87 JSON, 4.03 Markdown, ~3.0 for
 * fact-style bullets; and 3.23 on onyourleft's promptVersion-4 Phase-1 prompts
 * (prompt characters ÷ recorded input tokens, 133 modules). 3.5 is the
 * conservative code figure. (Phase-2 prompts looked like ~1.5 only because
 * each carries its facts twice — as the blob and as citable sources.)
 */
export const PHASE1_INPUT_CHARS_PER_TOKEN = 3.5;

/** Registry key for the per-call Phase-1 input budget, in tokens. */
export const PHASE1_CHUNK_INPUT_TOKENS_KEY = "DOCS_GEN_PHASE1_CHUNK_INPUT_TOKENS";

/**
 * Default most INPUT tokens (source + formulas + mined inventory) one Phase-1
 * call reads: 24,000 tokens ≈ 84,000 chars. Prompt processing slows sharply
 * with length on the local host (≈468 tok/s up to 48K tokens, ≈203 tok/s
 * averaged at 132K), so chunks stay modest; with a 16,384-token output cap the
 * estimated-output budget (~34K chars) binds first on code anyway.
 */
export const DEFAULT_PHASE1_CHUNK_INPUT_TOKENS = 24_000;

/** The configured Phase-1 input budget in tokens (db → env), or the default. */
export function resolvePhase1ChunkInputTokens(config: ConfigService = getConfigService()): number {
  const raw = config.getNumber(PHASE1_CHUNK_INPUT_TOKENS_KEY, DEFAULT_PHASE1_CHUNK_INPUT_TOKENS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_PHASE1_CHUNK_INPUT_TOKENS;
}

/**
 * The char cap each language's mined inventory is rendered under in the prompt.
 * A chunk is planned so that no language's inventory reaches it, so the
 * renderer never truncates.
 */
export const PHASE1_MINED_RENDER_CAP = 12_000;

export interface Phase1ChunkLimits {
  inputChars: number;
  /** Estimated reply characters one call may write. */
  outputChars: number;
  /** Per-language rendered mined-inventory characters. */
  minedChars: number;
}

/** Registry key: whether Phase 1 reads and mines test/spec/fixture files. */
export const PHASE1_INCLUDE_TESTS_KEY = "DOCS_GEN_PHASE1_INCLUDE_TESTS";

/**
 * Whether Phase 1 includes test, spec and fixture files (db → env). Default
 * true: full coverage is the safe default; a run that only wants production
 * rules turns it off.
 */
export function resolvePhase1IncludeTests(config: ConfigService = getConfigService()): boolean {
  return config.getBool(PHASE1_INCLUDE_TESTS_KEY, true);
}

/** Limits for one Phase-1 call at an output cap of `maxTokens` and an input budget in tokens. */
export function phase1ChunkLimits(
  maxTokens: number,
  inputTokens: number = DEFAULT_PHASE1_CHUNK_INPUT_TOKENS,
): Phase1ChunkLimits {
  return {
    inputChars: Math.floor(inputTokens * PHASE1_INPUT_CHARS_PER_TOKEN),
    outputChars: Math.max(1, Math.floor(maxTokens * CHARS_PER_OUTPUT_TOKEN * BATCH_OUTPUT_MARGIN)),
    minedChars: PHASE1_MINED_RENDER_CAP,
  };
}

/** Prompt bucket a rule is rendered in: TS and JS share one inventory. */
function inventoryBucket(r: PersistedMinedRule): string {
  return r.language === "js" ? "ts" : r.language;
}

/** Characters one rule adds to its language's rendered inventory (`- <file>:<line>: <summary>`). */
export function minedRuleRenderChars(r: PersistedMinedRule): number {
  return `- ${r.file}:${r.line}: ${r.summary}`.length;
}

/** Characters one formula adds to the prompt's pre-extracted formulas list. */
export function formulaRenderChars(f: ExtractedFormula): number {
  return `- ${f.kind}: ${f.expression.slice(0, 200)}`.length + 1;
}

interface Cost {
  input: number;
  output: number;
  mined: Map<string, number>;
}

function unitCost(u: Phase1Unit): Cost {
  const mined = new Map<string, number>();
  let minedTotal = 0;
  for (const r of u.rules) {
    const c = minedRuleRenderChars(r);
    mined.set(inventoryBucket(r), (mined.get(inventoryBucket(r)) ?? 0) + c);
    minedTotal += c + 1;
  }
  const source = u.inventoryOnly ? 0 : renderUnit(u).length + UNIT_SEPARATOR.length;
  const steps =
    u.sasSteps.length > 0
      ? renderSasWorkflow({ steps: u.sasSteps }, Number.POSITIVE_INFINITY).length +
        renderSasDataLineage({ steps: u.sasSteps }, Number.POSITIVE_INFINITY).length
      : 0;
  return {
    input: source + minedTotal + steps + u.formulas.reduce((n, f) => n + formulaRenderChars(f), 0),
    output: Math.ceil(
      u.text.length * PHASE1_OUTPUT_CHARS_PER_SOURCE_CHAR +
        u.rules.length * PHASE1_OUTPUT_CHARS_PER_MINED_RULE +
        u.sasSteps.length * PHASE1_OUTPUT_CHARS_PER_SAS_STEP,
    ),
    mined,
  };
}

function addCost(a: Cost, b: Cost): Cost {
  const mined = new Map(a.mined);
  for (const [k, v] of b.mined) mined.set(k, (mined.get(k) ?? 0) + v);
  return { input: a.input + b.input, output: a.output + b.output, mined };
}

const ZERO: Cost = { input: 0, output: 0, mined: new Map() };

function sumCost(units: readonly Phase1Unit[]): Cost {
  return units.reduce((acc, u) => addCost(acc, unitCost(u)), ZERO);
}

/**
 * The fixed per-call output share at these limits: {@link PHASE1_OUTPUT_CHARS_PER_CHUNK},
 * but never more than a quarter of the budget, so a small output cap still
 * leaves room for code.
 */
function overheadChars(limits: Phase1ChunkLimits): number {
  return Math.min(PHASE1_OUTPUT_CHARS_PER_CHUNK, Math.floor(limits.outputChars / 4));
}

function fits(c: Cost, limits: Phase1ChunkLimits): boolean {
  if (c.input > limits.inputChars) return false;
  if (c.output + overheadChars(limits) > limits.outputChars) return false;
  for (const v of c.mined.values()) if (v > limits.minedChars) return false;
  return true;
}

/** Estimated reply characters for a chunk, including the fixed per-call part. */
export function chunkOutputChars(chunk: readonly Phase1Unit[]): number {
  return sumCost(chunk).output + PHASE1_OUTPUT_CHARS_PER_CHUNK;
}

/** Estimated input characters (source, formulas, mined inventory) for a chunk. */
export function chunkInputChars(chunk: readonly Phase1Unit[]): number {
  return sumCost(chunk).input;
}

/**
 * Cut a unit in two at its middle line. Its mined rules, formulas and SAS steps
 * go with the half that holds their line. `null` for a one-line unit.
 */
export function splitUnitByLines(u: Phase1Unit): [Phase1Unit, Phase1Unit] | null {
  if (u.endLine <= u.startLine) return null;
  const mid = Math.floor((u.startLine + u.endLine) / 2);
  const lines = u.text.split("\n");
  const partOf = u.partOf ?? { startLine: u.startLine, endLine: u.endLine };
  const half = (from: number, to: number): Phase1Unit => ({
    ...u,
    startLine: from,
    endLine: to,
    text: lines.slice(from - u.startLine, to - u.startLine + 1).join("\n"),
    partOf,
    rules: u.rules.filter((r) => r.line >= from && r.line <= to),
    formulas: u.formulas.filter((f) => f.startLine >= from && f.startLine <= to),
    sasSteps: u.sasSteps.filter((s) => s.line >= from && s.line <= to),
    // The symbols are reported by the first half only, so coverage counts each once.
    symbols: from === u.startLine ? u.symbols : [],
  });
  return [half(u.startLine, mid), half(mid + 1, u.endLine)];
}

/**
 * A unit that does not fit one call on its own, cut by lines until every piece
 * does (or is a single line, which is kept as is — a single line cannot be cut).
 */
export function fitUnitToLimits(u: Phase1Unit, limits: Phase1ChunkLimits): Phase1Unit[] {
  if (fits(unitCost(u), limits)) return [u];
  const halves = splitUnitByLines(u);
  if (!halves) return [u];
  return [...fitUnitToLimits(halves[0], limits), ...fitUnitToLimits(halves[1], limits)];
}

/**
 * Pack units into Phase-1 chunks. Units arrive in file order; a file's units are
 * kept in one chunk whenever the whole file fits one, and a file larger than a
 * chunk is packed across consecutive chunks in line order. Every unit lands in
 * exactly one chunk (oversized units are first cut by {@link fitUnitToLimits}).
 * An empty input plans no chunk; the caller decides what an empty module means.
 */
export function planPhase1Chunks(
  units: readonly Phase1Unit[],
  limits: Phase1ChunkLimits,
): Phase1Unit[][] {
  const fitted = units.flatMap((u) => fitUnitToLimits(u, limits));
  const files: Phase1Unit[][] = [];
  for (const u of fitted) {
    const last = files[files.length - 1];
    if (last && last[0].filePath === u.filePath) last.push(u);
    else files.push([u]);
  }
  const chunks: Phase1Unit[][] = [];
  let current: Phase1Unit[] = [];
  let cost = ZERO;
  const close = (): void => {
    if (current.length > 0) chunks.push(current);
    current = [];
    cost = ZERO;
  };
  for (const file of files) {
    const fileCost = sumCost(file);
    if (fits(addCost(cost, fileCost), limits)) {
      for (const u of file) current.push(u);
      cost = addCost(cost, fileCost);
      continue;
    }
    close();
    if (fits(fileCost, limits)) {
      for (const u of file) current.push(u);
      cost = fileCost;
      continue;
    }
    for (const u of file) {
      const c = unitCost(u);
      if (current.length > 0 && !fits(addCost(cost, c), limits)) close();
      current.push(u);
      cost = addCost(cost, c);
    }
  }
  close();
  return chunks;
}

/**
 * Split a chunk whose reply was cut off by the output cap: two halves balanced
 * by estimated output, or — for a single unit — its two line halves. `null`
 * when nothing smaller exists (a one-line unit).
 */
export function splitPhase1Chunk(
  chunk: readonly Phase1Unit[],
): [Phase1Unit[], Phase1Unit[]] | null {
  if (chunk.length === 1) {
    const halves = splitUnitByLines(chunk[0]);
    return halves ? [[halves[0]], [halves[1]]] : null;
  }
  if (chunk.length < 1) return null;
  const outputs = chunk.map((u) => unitCost(u).output);
  const total = outputs.reduce((a, b) => a + b, 0);
  let best = 1;
  let bestGap = Infinity;
  let left = 0;
  for (let i = 1; i < chunk.length; i++) {
    left += outputs[i - 1];
    const gap = Math.abs(total - 2 * left);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return [chunk.slice(0, best), chunk.slice(best)];
}

/**
 * Most times one planned chunk may be halved after a cut-off reply (so at most
 * 2^depth leaf calls), and the smallest estimated share of the output budget
 * (beyond the fixed per-call part) a chunk's code must have for its size to
 * explain the cut-off. Below that the model is
 * running away (repeating itself), not running out of room, and splitting
 * would only buy more full-cap calls — the same rule as section batching's
 * `MIN_SPLIT_BUDGET_FRACTION` (#165).
 */
export const MAX_PHASE1_SPLIT_DEPTH = 4;
export const MIN_PHASE1_SPLIT_FRACTION = 0.25;

/** Whether a unit on its own fits one call at these limits. */
export function unitFitsLimits(u: Phase1Unit, limits: Phase1ChunkLimits): boolean {
  return fits(unitCost(u), limits);
}

/** Whether a cut-off chunk at `depth` should be split and re-extracted. */
export function shouldSplitPhase1Chunk(
  chunk: readonly Phase1Unit[],
  depth: number,
  limits: Phase1ChunkLimits,
): boolean {
  const room = limits.outputChars - overheadChars(limits);
  return (
    depth < MAX_PHASE1_SPLIT_DEPTH &&
    sumCost(chunk).output >= room * MIN_PHASE1_SPLIT_FRACTION &&
    splitPhase1Chunk(chunk) !== null
  );
}

// ============================================================================
// 4. Merging chunk replies
// ============================================================================

/** The Phase-1 prompt's headings, in the order a merged reply lists them. */
export const PHASE1_HEADINGS = [
  "PURPOSE",
  "ENTITIES",
  "RULES",
  "WORKFLOWS",
  "FORMULAS",
  "INTEGRATIONS",
  "KEY_APIS",
  "STATUS_TRANSITIONS",
  "NOTES",
] as const;

/**
 * A heading line as the model writes it, tolerating the decorations small
 * models add (`## RULES`, `**RULES**`, `RULES:`); group 2 is any first item
 * written on the heading line. Upper-case only, so prose is never a heading.
 */
const HEADING_RE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:\d+[.)]\s*)?([A-Z][A-Z_ ]{2,}?)\s*(?:\*\*)?\s*(?::\s*(?:\*\*)?\s*([^*\s].*?))?\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/;
const KNOWN_HEADINGS: ReadonlySet<string> = new Set([...PHASE1_HEADINGS, "DATA_LINEAGE"]);
/** A body that says nothing. */
const EMPTY_BODY = /^\(?\s*none\b[^)]*\)?\.?$/i;
/** A top-level unordered bullet: the start of one fact. */
const TOP_BULLET = /^[-•*]\s/;

function headingToken(line: string): { token: string; inline: string | null } | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const token = m[1].trim().replace(/\s+/g, "_");
  return KNOWN_HEADINGS.has(token) ? { token, inline: m[2] ?? null } : null;
}

/**
 * The items of a section body: each top-level `-`/`•`/`*` bullet together with
 * its indented continuation lines, or a run of other lines (prose, numbered
 * steps) as one item.
 */
function bodyItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  let cur: string[] = [];
  const flush = (): void => {
    const text = cur.join("\n").trim();
    if (text) items.push(text);
    cur = [];
  };
  for (const line of lines) {
    if (TOP_BULLET.test(line)) flush();
    cur.push(line);
  }
  flush();
  return items;
}

/**
 * Merge the facts replies of one module's chunks into one facts text, section
 * by section in {@link PHASE1_HEADINGS} order, keeping each identical fact
 * (bullet with its sub-lines) once. Text a reply wrote before any heading is
 * kept under PURPOSE; sections that say only "(none)" are dropped. A single
 * reply is returned unchanged, so a module that fits one call produces exactly
 * the facts it always did.
 */
export function mergePhase1ChunkFacts(replies: readonly string[]): string {
  if (replies.length === 1) return replies[0];
  const sections = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  const add = (token: string, lines: string[]): void => {
    const body = lines.join("\n").trim();
    if (!body || EMPTY_BODY.test(body)) return;
    if (!sections.has(token)) {
      sections.set(token, []);
      seen.set(token, new Set());
    }
    const out = sections.get(token)!;
    const dedupe = seen.get(token)!;
    for (const item of bodyItems(lines)) {
      const key = item.replace(/\s+/g, " ").trim();
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      out.push(item);
    }
  };
  for (const reply of replies) {
    let token = "PURPOSE";
    let body: string[] = [];
    for (const line of reply.split("\n")) {
      const h = headingToken(line);
      if (h) {
        add(token, body);
        token = h.token;
        body = h.inline ? [h.inline] : [];
      } else {
        body.push(line);
      }
    }
    add(token, body);
  }
  const order = [
    ...PHASE1_HEADINGS,
    ...[...sections.keys()].filter((k) => !PHASE1_HEADINGS.includes(k as never)),
  ];
  return order
    .filter((token) => (sections.get(token)?.length ?? 0) > 0)
    .map((token) => `${token}\n${sections.get(token)!.join("\n")}`)
    .join("\n\n");
}

// ============================================================================
// 5. Coverage accounting
// ============================================================================

/** How much of a module Phase 1 read. */
export interface Phase1Coverage {
  /** Functions in some PLANNED chunk (planned coverage). */
  functionsIncluded: number;
  functionsTotal: number;
  /**
   * Functions whose chunk produced complete facts (a complete reply or a cache
   * hit). Equals `functionsIncluded` only when no chunk failed or stayed cut off;
   * the rest are counted below, never as read.
   */
  functionsExtracted: number;
  /** Functions in a leaf chunk whose reply was still cut off (partial facts). */
  functionsInTruncatedChunks: number;
  /** Functions in a leaf chunk whose call failed (no facts). */
  functionsInFailedChunks: number;
  /** Units too large for one call even after splitting to a single line (sent over budget). */
  oversizedUnits: number;
  /** Over-long lines the formula extractor skipped (see {@link FORMULA_LINE_CHAR_LIMIT}). */
  formulaLinesSkipped: number;
  sourceCharsIncluded: number;
  sourceCharsTotal: number;
  /** Planned chunks. */
  chunks: number;
  /** Calls actually made (splits add calls; cache hits are not calls). */
  calls: number;
  cacheHits: number;
  /** Leaf chunks whose reply was still cut off (partial facts, not cached). */
  truncatedChunks: number;
  /** Leaf chunks whose call failed (no facts, not cached). */
  failedChunks: number;
}

/**
 * Functions and source characters covered by `chunks`, against the module's
 * callable symbols and the characters of the files that were read.
 */
export function measureChunkCoverage(
  chunks: readonly (readonly Phase1Unit[])[],
  callables: readonly SymbolRange[],
  fileChars: number,
): Pick<
  Phase1Coverage,
  "functionsIncluded" | "functionsTotal" | "sourceCharsIncluded" | "sourceCharsTotal"
> {
  const included = new Set<string>();
  let chars = 0;
  for (const chunk of chunks) {
    for (const u of chunk) {
      for (const s of u.symbols) included.add(s);
      chars += u.text.length;
    }
  }
  const total = new Set(callables.map(symbolKey));
  return {
    functionsIncluded: [...total].filter((q) => included.has(q)).length,
    functionsTotal: total.size,
    sourceCharsIncluded: chars,
    sourceCharsTotal: fileChars,
  };
}
