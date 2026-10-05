/**
 * "Tested by" for requirements — Issue #814 (Epic #812).
 *
 * Resolves which TESTS cover a requirement from the code it is already mapped
 * to (`RequirementCodeMapping`, and `RequirementSpecMapping` → `SpecCodeMapping`),
 * with no model call and no new table. Three relations, strongest first:
 *
 * | relation    | rule                                                                    | base |
 * |-------------|-------------------------------------------------------------------------|------|
 * | `direct`    | a mapped target's file classifies as a test                             | 1.0  |
 * | `exercises` | a test-file symbol has an incoming `calls`/`references` edge into a      | 0.8  |
 * |             | target symbol (a file-only target = every symbol in that file, capped)  |      |
 * | `naming`    | a test case in `siblingTestPaths(target)` is named for a target symbol  | 0.6  |
 * |             | (prefix match, see {@link matchTestSubject}), or — file-only target —   |      |
 * |             | shares a denoised requirement token                                     |      |
 *
 * `imports` edges are deliberately NOT followed: for a file-only target they
 * would link every test that imports the package.
 *
 * Three guards keep a broad mapping from fanning out (#860):
 *  - A file-only target that records a line range expands only to the symbols
 *    overlapping that range, not the whole file.
 *  - A test file mapped by a line range that covers none of its symbols (a
 *    citation of its licence header or imports) is not a `direct` link.
 *  - A **hub** target — one exercised by tests in at least
 *    `TESTED_BY_HUB_MIN_TEST_FILES` distinct test files, like a config file or a
 *    constructor every test calls — links an `exercises` test only when the test,
 *    or the symbol it calls, shares at least two of the requirement's words.
 *
 * Within a relation, tests are ordered by BM25 relevance of `name + qualifiedName`
 * against `denoiseRequirementQuery(title + body)`, folded into `score`. Results
 * are deduplicated by `(filePath, qualifiedName)`, keeping the strongest relation.
 *
 * Batched: the Prisma query count is constant in the number of requirements.
 * Every query filters on `projectId`; file-path matching against sibling-test
 * conventions is done in code on stored rows and passed to Prisma only as bound
 * `in` values, never interpolated into SQL.
 */
import type {
  RequirementTestGap,
  RequirementTestGaps,
  TestLinkRelation,
  TraceabilityTestNode,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { BM25Index, tokenizeCodeRoots } from "../code-graph/hybrid-search.js";
import { classifyTestSymbol, siblingTestPaths } from "../code-graph/test-conventions.js";
import { getConfigService } from "../config/config-service.js";
import { denoiseRequirementQuery } from "./requirement-code-mapping.js";

export type TestedByPrisma = Pick<
  PrismaClient,
  | "analysis"
  | "requirement"
  | "requirementCodeMapping"
  | "requirementSpecMapping"
  | "specCodeMapping"
  | "codeSymbol"
  | "codeEdge"
>;

export interface TestedByDeps {
  prisma?: TestedByPrisma;
  /** Overrides `TESTED_BY_MAX_SYMBOLS_PER_FILE`. */
  maxSymbolsPerFile?: number;
  /** Overrides `TESTED_BY_HUB_MIN_TEST_FILES`. */
  hubMinTestFiles?: number;
}

/** Default cap on the symbols a file-only target expands to. */
export const DEFAULT_TESTED_BY_MAX_SYMBOLS_PER_FILE = 500;
/** Default number of distinct exercising test files that makes a target a hub (#860). */
export const DEFAULT_TESTED_BY_HUB_MIN_TEST_FILES = 5;
export const DEFAULT_TESTED_BY_LIMIT = 10;

const BASE_SCORE: Record<TestLinkRelation, number> = { direct: 1, exercises: 0.8, naming: 0.6 };
const RELATION_RANK: Record<TestLinkRelation, number> = { direct: 0, exercises: 1, naming: 2 };
/** Name tokens that mark a test rather than say what it tests. */
const TEST_NAME_TOKENS = new Set(["test", "tests", "benchmark", "fuzz", "example", "spec"]);
/** Shortest folded symbol name a test-name prefix may match (`Val` must not win). */
const MIN_SUBJECT_LENGTH = 3;

function pickPrisma(deps?: TestedByDeps): TestedByPrisma {
  return deps?.prisma ?? (defaultPrisma as unknown as TestedByPrisma);
}

function maxSymbolsPerFile(deps?: TestedByDeps): number {
  return (
    deps?.maxSymbolsPerFile ??
    getConfigService().getNumber(
      "TESTED_BY_MAX_SYMBOLS_PER_FILE",
      DEFAULT_TESTED_BY_MAX_SYMBOLS_PER_FILE,
    )
  );
}

function hubMinTestFiles(deps?: TestedByDeps): number {
  return (
    deps?.hubMinTestFiles ??
    getConfigService().getNumber(
      "TESTED_BY_HUB_MIN_TEST_FILES",
      DEFAULT_TESTED_BY_HUB_MIN_TEST_FILES,
    )
  );
}

/** A requirement's mapped code location (direct or via a spec). */
export interface TestedByTarget {
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  /** End of the mapped range; absent or null means the range is `startLine` alone. */
  endLine?: number | null;
}

/** The requirement fields resolution reads. */
export interface TestedByRequirement {
  id: string;
  title: string;
  body?: string | null;
}

interface SymbolRow {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  kind: string;
  language: string | null;
  startLine: number;
  endLine: number;
}

const SYMBOL_SELECT = {
  id: true,
  name: true,
  qualifiedName: true,
  filePath: true,
  kind: true,
  language: true,
  startLine: true,
  endLine: true,
} as const;

const fold = (s: string): string => s.replace(/[_\-.]/g, "").toLowerCase();
const isSeparator = (ch: string): boolean => ch === "_" || ch === "-" || ch === ".";

/**
 * True when, in `original`, the position just after its first `foldedLength`
 * non-separator characters is a word boundary: the end, a separator, an
 * upper-case letter or a digit (`ValidatePassword|RejectsEmpty`, `validate_password|_x`).
 */
function boundaryAfter(original: string, foldedLength: number): boolean {
  let seen = 0;
  let i = 0;
  for (; i < original.length && seen < foldedLength; i++) {
    if (!isSeparator(original[i])) seen++;
  }
  if (i >= original.length) return true;
  const ch = original[i];
  return isSeparator(ch) || /[A-Z0-9]/.test(ch);
}

/** The keys a symbol can be matched by: its name, and its `Type.method` tail. */
function symbolKeys(sym: Pick<SymbolRow, "name" | "qualifiedName">): string[] {
  const tail = sym.qualifiedName.slice(sym.qualifiedName.lastIndexOf("::") + 2);
  return tail && tail !== sym.name ? [sym.name, tail] : [sym.name];
}

/**
 * Pick the target symbol a test is named for: the LONGEST symbol key whose folded
 * form is a prefix of the test's folded subject, ending on a word boundary and at
 * least {@link MIN_SUBJECT_LENGTH} long. So `TestValidatePasswordRejectsEmpty`
 * matches `ValidatePassword` over `Validate`, `TestUser_Validate` matches
 * `User.Validate` over the type `User`, and `Val` never matches.
 *
 * The subject starts where the classifier's `subjectHint` starts in the test
 * name, so a Go `_`-suffix the classifier drops (`User_Validate`) is kept.
 */
export function matchTestSubject<T extends Pick<SymbolRow, "name" | "qualifiedName">>(
  testName: string,
  subjectHint: string | null,
  candidates: readonly T[],
): T | null {
  if (!subjectHint) return null;
  const at = testName.indexOf(subjectHint);
  const subject = at >= 0 ? testName.slice(at) : subjectHint;
  const folded = fold(subject);
  let best: T | null = null;
  let bestLength = 0;
  for (const candidate of candidates) {
    for (const key of symbolKeys(candidate)) {
      const k = fold(key);
      if (k.length < MIN_SUBJECT_LENGTH || k.length <= bestLength) continue;
      if (folded.startsWith(k) && boundaryAfter(subject, k.length)) {
        best = candidate;
        bestLength = k.length;
      }
    }
  }
  return best;
}

function nameTokens(name: string): string[] {
  return tokenizeCodeRoots(name).filter((t) => !TEST_NAME_TOKENS.has(t));
}

/**
 * The words of an identifier or sentence, split at every case, digit and
 * underscore boundary (`OAuth2UserCreation`, `OAUTH2_USER_CREATION` and
 * "oauth2 user creation" all give `oauth2 user creation`). Used only by the hub
 * relevance check (#860), which compares requirement words against names;
 * `tokenizeCodeRoots` keeps `snake_case` whole and so cannot.
 */
function words(text: string): Set<string> {
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return new Set(split.filter((w) => w.length >= MIN_SUBJECT_LENGTH && !TEST_NAME_TOKENS.has(w)));
}

/** Requirement words a hub link must share: two, or all of them for a one-word requirement. */
function sharesRequirementWords(name: string, requirementWords: ReadonlySet<string>): boolean {
  const needed = Math.min(2, requirementWords.size);
  if (needed === 0) return false;
  let shared = 0;
  for (const w of words(name)) if (requirementWords.has(w) && ++shared >= needed) return true;
  return false;
}

/** True when `sym` overlaps the target's recorded line range (always, with no range). */
function inTargetRange(sym: Pick<SymbolRow, "startLine" | "endLine">, t: TestedByTarget): boolean {
  if (t.startLine == null) return true;
  const end = t.endLine ?? t.startLine;
  return sym.startLine <= end && sym.endLine >= t.startLine;
}

interface Candidate {
  node: TraceabilityTestNode;
  key: string;
  qualifiedName: string;
}

function basename(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1);
}

function testNodeFromSymbol(
  sym: SymbolRow,
  relation: TestLinkRelation,
  subject: TraceabilityTestNode["subject"],
): TraceabilityTestNode {
  return {
    codeSymbolId: sym.id,
    filePath: sym.filePath,
    symbol: sym.qualifiedName,
    name: sym.name,
    startLine: sym.startLine,
    convention: classifyTestSymbol(sym).convention,
    relation,
    subject,
    score: BASE_SCORE[relation],
  };
}

/** Code graph rows loaded once for a whole batch of requirements. */
interface GraphRows {
  symbolById: Map<string, SymbolRow>;
  symbolsByFile: Map<string, SymbolRow[]>;
  edgesInto: Map<string, SymbolRow[]>;
  siblingSymbolsByFile: Map<string, SymbolRow[]>;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const targetIsTest = (t: TestedByTarget): boolean =>
  classifyTestSymbol({ filePath: t.filePath }).isTestFile;

/** Load symbols, incoming edges and sibling test symbols: three queries at most. */
async function loadGraph(
  prisma: TestedByPrisma,
  projectId: string,
  targets: TestedByTarget[],
  perFileCap: number,
): Promise<GraphRows> {
  const symbolIds = new Set<string>();
  const fileOnly = new Set<string>();
  // #860 — a test file mapped by a line range: load its symbols to tell a cited
  // test from a cited licence header. Not an edge target.
  const rangedTestFiles = new Set<string>();
  for (const t of targets) {
    if (t.codeSymbolId) symbolIds.add(t.codeSymbolId);
    else if (!targetIsTest(t)) fileOnly.add(t.filePath);
    else if (t.startLine != null) rangedTestFiles.add(t.filePath);
  }
  const graph: GraphRows = {
    symbolById: new Map(),
    symbolsByFile: new Map(),
    edgesInto: new Map(),
    siblingSymbolsByFile: new Map(),
  };

  const or: Array<Record<string, unknown>> = [];
  if (symbolIds.size) or.push({ id: { in: [...symbolIds] } });
  const byFile = new Set([...fileOnly, ...rangedTestFiles]);
  if (byFile.size) or.push({ filePath: { in: [...byFile] } });
  const targetRows: SymbolRow[] = or.length
    ? await prisma.codeSymbol.findMany({
        where: { projectId, OR: or },
        select: SYMBOL_SELECT,
        orderBy: [{ filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
      })
    : [];
  for (const row of targetRows) {
    if (symbolIds.has(row.id)) graph.symbolById.set(row.id, row);
    if (!byFile.has(row.filePath)) continue;
    const list = graph.symbolsByFile.get(row.filePath) ?? [];
    if (list.length < perFileCap) list.push(row);
    graph.symbolsByFile.set(row.filePath, list);
  }

  const edgeTargets = new Set<string>(graph.symbolById.keys());
  for (const file of fileOnly) {
    for (const s of graph.symbolsByFile.get(file) ?? []) edgeTargets.add(s.id);
  }
  if (edgeTargets.size) {
    const edges = await prisma.codeEdge.findMany({
      where: {
        projectId,
        kind: { in: ["calls", "references"] },
        toSymbolId: { in: [...edgeTargets] },
        fromSymbol: { projectId },
      },
      select: { toSymbolId: true, fromSymbol: { select: SYMBOL_SELECT } },
    });
    for (const e of edges) {
      if (!e.toSymbolId || !e.fromSymbol) continue;
      if (!classifyTestSymbol(e.fromSymbol).isTestFile) continue;
      pushTo(graph.edgesInto, e.toSymbolId, e.fromSymbol);
    }
  }

  const siblings = new Set<string>();
  for (const t of targets) {
    if (targetIsTest(t)) continue;
    const language = t.codeSymbolId ? graph.symbolById.get(t.codeSymbolId)?.language : undefined;
    for (const p of siblingTestPaths(t.filePath, language)) siblings.add(p);
  }
  if (siblings.size) {
    const rows = await prisma.codeSymbol.findMany({
      where: { projectId, filePath: { in: [...siblings] } },
      select: SYMBOL_SELECT,
      orderBy: [{ filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
    });
    for (const row of rows) pushTo(graph.siblingSymbolsByFile, row.filePath, row);
  }
  return graph;
}

/** Resolve one requirement's tests from its targets against the loaded graph. */
function resolveOne(
  requirement: TestedByRequirement,
  targets: TestedByTarget[],
  graph: GraphRows,
  limit: number,
  hubThreshold: number,
): TraceabilityTestNode[] {
  const query = denoiseRequirementQuery(`${requirement.title} ${requirement.body ?? ""}`);
  const queryTokens = new Set(nameTokens(query));
  const requirementWords = words(query);
  const byKey = new Map<string, Candidate>();
  const offer = (node: TraceabilityTestNode): void => {
    const key = `${node.filePath}::${node.symbol}`;
    const existing = byKey.get(key);
    if (existing && RELATION_RANK[existing.node.relation] <= RELATION_RANK[node.relation]) return;
    byKey.set(key, { node, key, qualifiedName: node.symbol });
  };

  for (const t of targets) {
    if (targetIsTest(t)) {
      const sym = t.codeSymbolId ? graph.symbolById.get(t.codeSymbolId) : undefined;
      if (!t.codeSymbolId && t.startLine != null) {
        // #860 — a range that covers none of the file's symbols cites its
        // header (licence, imports), not a test.
        const fileSymbols = graph.symbolsByFile.get(t.filePath) ?? [];
        if (fileSymbols.length > 0 && !fileSymbols.some((s) => inTargetRange(s, t))) continue;
      }
      offer(
        sym
          ? testNodeFromSymbol(sym, "direct", null)
          : {
              codeSymbolId: t.codeSymbolId,
              filePath: t.filePath,
              symbol: t.filePath,
              name: basename(t.filePath),
              startLine: t.startLine,
              convention: classifyTestSymbol({ filePath: t.filePath }).convention,
              relation: "direct",
              subject: null,
              score: BASE_SCORE.direct,
            },
      );
      continue;
    }

    const fileOnly = !t.codeSymbolId;
    const one = t.codeSymbolId ? graph.symbolById.get(t.codeSymbolId) : undefined;
    const targetSymbols = fileOnly
      ? (graph.symbolsByFile.get(t.filePath) ?? []).filter((s) => inTargetRange(s, t))
      : one
        ? [one]
        : [];

    const exercised: Array<{ from: SymbolRow; ts: SymbolRow }> = [];
    for (const ts of targetSymbols) {
      for (const from of graph.edgesInto.get(ts.id) ?? []) exercised.push({ from, ts });
    }
    // #860 — through a hub, being called is not evidence of testing THIS
    // requirement: keep only tests about it (by the test's or the callee's name).
    const hub = new Set(exercised.map((x) => x.from.filePath)).size >= hubThreshold;
    for (const { from, ts } of exercised) {
      if (
        hub &&
        !sharesRequirementWords(from.name, requirementWords) &&
        !sharesRequirementWords(ts.name, requirementWords)
      ) {
        continue;
      }
      offer(
        testNodeFromSymbol(from, "exercises", {
          filePath: ts.filePath,
          symbol: ts.qualifiedName,
        }),
      );
    }

    for (const p of siblingTestPaths(t.filePath, one?.language)) {
      for (const sym of graph.siblingSymbolsByFile.get(p) ?? []) {
        const c = classifyTestSymbol(sym);
        if (!c.isTestSymbol) continue;
        const matched = matchTestSubject(sym.name, c.subjectHint, targetSymbols);
        if (matched) {
          offer(
            testNodeFromSymbol(sym, "naming", {
              filePath: matched.filePath,
              symbol: matched.qualifiedName,
            }),
          );
        } else if (fileOnly && nameTokens(sym.name).some((tok) => queryTokens.has(tok))) {
          offer(testNodeFromSymbol(sym, "naming", { filePath: t.filePath, symbol: null }));
        }
      }
    }
  }

  const candidates = [...byKey.values()];
  if (candidates.length === 0) return [];
  const index = new BM25Index();
  index.build(
    candidates.map((c) => ({
      symbolId: c.key,
      name: c.node.name,
      qualifiedName: c.qualifiedName,
      kind: "function",
      filePath: c.node.filePath,
    })),
  );
  const raw = new Map(index.score(query).map((r) => [r.symbolId, r.score] as const));
  const max = Math.max(0, ...raw.values());
  for (const c of candidates) {
    const relevance = max > 0 ? (raw.get(c.key) ?? 0) / max : 0;
    c.node.score = Math.round(BASE_SCORE[c.node.relation] * (0.8 + 0.2 * relevance) * 1000) / 1000;
  }
  candidates.sort(
    (a, b) =>
      RELATION_RANK[a.node.relation] - RELATION_RANK[b.node.relation] ||
      b.node.score - a.node.score ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return candidates.slice(0, limit).map((c) => c.node);
}

/**
 * Load the direct and spec→code targets of every requirement: three queries at
 * most. A requirement absent from the map has no mapped code (`no-code`).
 */
export async function loadTestedByTargets(
  prisma: TestedByPrisma,
  projectId: string,
  requirementIds: string[],
): Promise<Map<string, TestedByTarget[]>> {
  const targets = new Map<string, TestedByTarget[]>();
  if (requirementIds.length === 0) return targets;
  const select = { codeSymbolId: true, filePath: true, startLine: true, endLine: true } as const;
  const [direct, specLinks] = await Promise.all([
    prisma.requirementCodeMapping.findMany({
      where: { projectId, requirementId: { in: requirementIds } },
      select: { requirementId: true, ...select },
    }),
    prisma.requirementSpecMapping.findMany({
      where: { projectId, requirementId: { in: requirementIds } },
      select: { requirementId: true, specDocumentId: true },
    }),
  ]);
  for (const row of direct) pushTo(targets, row.requirementId, row);

  const specIds = [...new Set(specLinks.map((s) => s.specDocumentId))];
  if (specIds.length) {
    const specCode = await prisma.specCodeMapping.findMany({
      where: { projectId, specDocumentId: { in: specIds } },
      select: { specDocumentId: true, ...select },
    });
    const bySpec = new Map<string, TestedByTarget[]>();
    for (const row of specCode) pushTo(bySpec, row.specDocumentId, row);
    for (const link of specLinks) {
      for (const row of bySpec.get(link.specDocumentId) ?? []) {
        pushTo(targets, link.requirementId, row);
      }
    }
  }
  return targets;
}

/**
 * Resolve tests for requirements whose mapped targets the caller already holds
 * (the traceability spine has just read them). Three queries at most.
 */
export async function resolveTestedByForTargets(
  projectId: string,
  requirements: readonly TestedByRequirement[],
  targetsByRequirement: ReadonlyMap<string, TestedByTarget[]>,
  opts?: { limit?: number },
  deps?: TestedByDeps,
): Promise<Map<string, TraceabilityTestNode[]>> {
  const prisma = pickPrisma(deps);
  const limit = opts?.limit ?? DEFAULT_TESTED_BY_LIMIT;
  const all = requirements.flatMap((r) => targetsByRequirement.get(r.id) ?? []);
  const graph = await loadGraph(prisma, projectId, all, maxSymbolsPerFile(deps));
  const hubThreshold = hubMinTestFiles(deps);
  const out = new Map<string, TraceabilityTestNode[]>();
  for (const r of requirements) {
    out.set(r.id, resolveOne(r, targetsByRequirement.get(r.id) ?? [], graph, limit, hubThreshold));
  }
  return out;
}

/**
 * Tests covering each requirement, strongest first, at most `limit` (default 10)
 * each. Requirements not in the project (or soft-deleted) are absent from the map.
 */
export async function resolveTestedBy(
  projectId: string,
  requirementIds: string[],
  opts?: { limit?: number },
  deps?: TestedByDeps,
): Promise<Map<string, TraceabilityTestNode[]>> {
  const prisma = pickPrisma(deps);
  if (requirementIds.length === 0) return new Map();
  const requirements = await prisma.requirement.findMany({
    where: { projectId, id: { in: requirementIds }, deletedAt: null },
    select: { id: true, title: true, body: true },
  });
  const ids = requirements.map((r) => r.id);
  const targets = await loadTestedByTargets(prisma, projectId, ids);
  return resolveTestedByForTargets(projectId, requirements, targets, opts, deps);
}

/**
 * The project's requirements that have mapped code but no resolved test, one
 * page at a time (ordered by requirement id; `cursor` = the last id of the
 * previous page). A requirement with no mapped code cannot be judged, so it is
 * counted in `noCode` and never listed. Soft-deleted requirements are excluded.
 * An `analysisId` outside the project is a 404.
 */
export async function listUntestedRequirements(
  projectId: string,
  opts?: { analysisId?: string; limit?: number; cursor?: string },
  deps?: TestedByDeps,
): Promise<RequirementTestGaps> {
  const prisma = pickPrisma(deps);
  const limit = opts?.limit ?? 50;
  if (opts?.analysisId) {
    const analysis = await prisma.analysis.findFirst({
      where: { id: opts.analysisId, projectId },
      select: { id: true },
    });
    if (!analysis) {
      throw new AppError(404, "ANALYSIS_NOT_FOUND", "analysis not found in this project");
    }
  }

  const requirements = await prisma.requirement.findMany({
    where: {
      projectId,
      deletedAt: null,
      ...(opts?.analysisId ? { analysisId: opts.analysisId } : {}),
    },
    select: { id: true, title: true, body: true, analysisId: true },
  });
  requirements.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const targets = await loadTestedByTargets(
    prisma,
    projectId,
    requirements.map((r) => r.id),
  );
  const tests = await resolveTestedByForTargets(
    projectId,
    requirements,
    targets,
    { limit: 1 },
    deps,
  );

  let tested = 0;
  let noCode = 0;
  const untested: RequirementTestGap[] = [];
  for (const r of requirements) {
    const mappedFiles = new Set((targets.get(r.id) ?? []).map((t) => t.filePath)).size;
    if (mappedFiles === 0) {
      noCode++;
    } else if ((tests.get(r.id) ?? []).length > 0) {
      tested++;
    } else {
      untested.push({
        requirementId: r.id,
        title: r.title,
        analysisId: r.analysisId ?? null,
        reason: "no-test",
        mappedFiles,
      });
    }
  }

  const after = opts?.cursor;
  const remaining = after ? untested.filter((g) => g.requirementId > after) : untested;
  const page = remaining.slice(0, limit);
  return {
    total: requirements.length,
    tested,
    untested: page,
    noCode,
    nextCursor: remaining.length > limit ? page[page.length - 1].requirementId : null,
  };
}
