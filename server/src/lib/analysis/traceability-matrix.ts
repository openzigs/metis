/**
 * Requirement → findings → code → tests traceability matrix (Issue #737, Epic #726).
 *
 * PURE assembly + serialization. The matrix is built entirely from
 * already-persisted analysis data — the synthesized requirements, the finding
 * ids they were grounded in (`evidenceFindingIds`), those findings' CODE
 * citations (`filePath:startLine-endLine`, #734), the per-requirement coverage
 * label (#736), and the requirement→code spine (`RequirementCodeMapping`) — plus
 * a best-effort code-graph test-detection pass layered on by the service.
 *
 * Nothing here recomputes analysis output or calls an LLM: given the same
 * persisted rows it always yields the same matrix, so the whole module is
 * trivially unit-testable with plain objects. The CSV serializer reuses the
 * injection-safe RFC-4180 helpers from `../requirements/csv.ts`; the markdown
 * serializer escapes pipes/newlines so a requirement title can never break the
 * table structure.
 */
import {
  isCodeCitation,
  type Citation,
  type FindingSeverity,
  type RequirementCoverage,
  type RequirementVerdict,
  type TraceabilityCodeLocation,
  type TraceabilityFindingRef,
  type TraceabilityMatrix,
  type TraceabilityRow,
  type TraceabilityTestLink,
} from "@metis/shared";
import { toCsv } from "../requirements/csv.js";

/** Minimal requirement projection the builder needs (from the analysis snapshot). */
export interface MatrixRequirementInput {
  id: string;
  title: string;
  coverage: RequirementCoverage | null;
  /**
   * Issue #773 — the three-state verdict. The matrix used to imply a gap from a
   * `no_evidence` coverage cell; the verdict column says plainly whether the
   * requirement is implemented, a confirmed gap, or simply unverified.
   */
  verdict: RequirementVerdict | null;
  /** Finding row ids this requirement was grounded in (snapshot `evidenceFindingIds`). */
  evidenceFindingIds: string[];
}

/** Minimal finding projection the builder needs (from the analysis snapshot). */
export interface MatrixFindingInput {
  id: string;
  title: string;
  severity: FindingSeverity;
  citations: Citation[];
}

export interface BuildTraceabilityMatrixInput {
  analysisId: string;
  projectId: string;
  requirements: MatrixRequirementInput[];
  /** Every analysis finding, keyed by id, so a requirement resolves its links. */
  findingsById: ReadonlyMap<string, MatrixFindingInput>;
  /**
   * Persisted `RequirementCodeMapping` spine locations per requirement id
   * (deterministic-mapping provenance). Optional — usually empty for a fresh
   * analysis (the seeder is not wired into the run), so citation-derived
   * locations are the primary source.
   */
  deterministicByRequirement?: ReadonlyMap<string, TraceabilityCodeLocation[]>;
  /**
   * Detected tests keyed by the code-graph symbol id they reference. Layered on
   * best-effort by the service; absent ⇒ every tests cell is empty.
   */
  testsBySymbolId?: ReadonlyMap<string, TraceabilityTestLink[]>;
}

/** Stable de-dupe key for a code location (path + range + provenance). */
function codeLocationKey(loc: TraceabilityCodeLocation): string {
  return `${loc.source}::${loc.filePath}:${loc.startLine ?? ""}-${loc.endLine ?? ""}`;
}

/**
 * Assemble the traceability matrix. PURE: no I/O, deterministic. Requirements
 * are emitted in input order; a requirement with no linked findings still emits
 * a row (empty findings/code/tests) so the UI/export can render an explicit
 * "none" cell rather than dropping it.
 */
export function buildTraceabilityMatrix(input: BuildTraceabilityMatrixInput): TraceabilityMatrix {
  const rows: TraceabilityRow[] = input.requirements.map((req) => {
    const findings: TraceabilityFindingRef[] = [];
    const codeByKey = new Map<string, TraceabilityCodeLocation>();
    const symbolIds = new Set<string>();

    for (const findingId of req.evidenceFindingIds) {
      const finding = input.findingsById.get(findingId);
      if (!finding) continue; // stale/deleted id — never invent a finding.
      findings.push({ id: finding.id, title: finding.title, severity: finding.severity });
      for (const citation of finding.citations) {
        if (!isCodeCitation(citation)) continue; // doc citations aren't code locations.
        const loc: TraceabilityCodeLocation = {
          filePath: citation.filePath,
          startLine: citation.startLine,
          endLine: citation.endLine,
          source: "citation",
          ...(citation.symbolId ? { symbolId: citation.symbolId } : {}),
        };
        codeByKey.set(codeLocationKey(loc), loc);
        if (citation.symbolId) symbolIds.add(citation.symbolId);
      }
    }

    // Fold in persisted deterministic-mapping spine locations (additive; usually
    // empty). Deduped against citation locations by (source, path, range).
    for (const loc of input.deterministicByRequirement?.get(req.id) ?? []) {
      codeByKey.set(codeLocationKey(loc), loc);
      if (loc.symbolId) symbolIds.add(loc.symbolId);
    }

    // Best-effort test detection: union the tests referencing any implicated
    // symbol, deduped by (filePath, symbol).
    const testsByKey = new Map<string, TraceabilityTestLink[]>();
    for (const symbolId of symbolIds) {
      for (const test of input.testsBySymbolId?.get(symbolId) ?? []) {
        testsByKey.set(`${test.filePath}::${test.symbol}`, [test]);
      }
    }

    return {
      requirementId: req.id,
      title: req.title,
      coverage: req.coverage,
      verdict: req.verdict,
      findings,
      codeLocations: [...codeByKey.values()],
      tests: [...testsByKey.values()].flat(),
    };
  });

  return {
    analysisId: input.analysisId,
    projectId: input.projectId,
    rows,
    testsDetection: "heuristic",
  };
}

// ── Cell formatting (shared by CSV + markdown) ──────────────────────────────

/** Render a code location as `filePath:start-end (source)`; path only when no range. */
export function formatCodeLocationCell(loc: TraceabilityCodeLocation): string {
  const range = loc.startLine != null ? `:${loc.startLine}-${loc.endLine ?? loc.startLine}` : "";
  return `${loc.filePath}${range} (${loc.source})`;
}

/** Render a detected test as `filePath::symbol`. */
export function formatTestCell(test: TraceabilityTestLink): string {
  return `${test.filePath}::${test.symbol}`;
}

/** Human-readable coverage label; a null coverage renders as an explicit dash. */
export function formatCoverageCell(coverage: RequirementCoverage | null): string {
  return coverage ?? "—";
}

/**
 * Issue #773 — human-readable verdict cell. Explicitly spells out that
 * `could-not-verify` is NOT a gap, because this table is read (and exported) by
 * people deciding what to build.
 */
export function formatVerdictCell(verdict: RequirementVerdict | null): string {
  switch (verdict) {
    case "implemented":
      return "implemented";
    case "gap-confirmed":
      return "gap-confirmed";
    case "could-not-verify":
      return "could-not-verify (NOT a confirmed gap)";
    default:
      return "—";
  }
}

const CSV_COLUMNS = [
  "Requirement",
  "Verdict",
  "Coverage",
  "Findings",
  "Code locations",
  "Tests",
] as const;

/**
 * Join a row's multi-valued cell entries into one string, or an explicit empty
 * marker so a blank cell never reads as "missing key". The marker differs for
 * tests ("none detected" — best-effort) vs findings/code ("none").
 */
function joinCell(values: string[], emptyMarker: string): string {
  return values.length > 0 ? values.join("; ") : emptyMarker;
}

/** Turn one matrix row into its ordered cell strings (pre-escape). */
function rowCells(row: TraceabilityRow): string[] {
  return [
    row.title,
    formatVerdictCell(row.verdict),
    formatCoverageCell(row.coverage),
    joinCell(
      row.findings.map((f) => `${f.title} (${f.severity})`),
      "none",
    ),
    joinCell(row.codeLocations.map(formatCodeLocationCell), "none"),
    joinCell(row.tests.map(formatTestCell), "none detected"),
  ];
}

/**
 * Serialize the matrix to an RFC-4180, injection-safe CSV. Escaping (quoting,
 * embedded quotes/commas/newlines, and spreadsheet formula neutralization) is
 * delegated to the shared `toCsv`/`toCsvField` helpers so a requirement title
 * containing `,`, `"`, a newline, or a leading `=`/`+`/`-`/`@` can never break
 * the document or be evaluated as a formula.
 */
export function serializeTraceabilityCsv(matrix: TraceabilityMatrix): string {
  const rows: string[][] = [[...CSV_COLUMNS], ...matrix.rows.map(rowCells)];
  return toCsv(rows);
}

/** Escape a single markdown table cell: pipes are literal, newlines become `<br>`. */
export function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/**
 * Serialize the matrix to a GitHub-flavoured markdown table. Every cell is run
 * through {@link escapeMarkdownCell} so user-controlled requirement/finding text
 * containing `|` or a newline cannot corrupt the table grid.
 */
export function serializeTraceabilityMarkdown(matrix: TraceabilityMatrix): string {
  const header = `| ${CSV_COLUMNS.map(escapeMarkdownCell).join(" | ")} |`;
  const divider = `| ${CSV_COLUMNS.map(() => "---").join(" | ")} |`;
  const body = matrix.rows.map((row) => `| ${rowCells(row).map(escapeMarkdownCell).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

/**
 * Path heuristic for a test file. Best-effort and language-agnostic: matches the
 * common JS/TS/Python/Go conventions (`*.test.*`, `*.spec.*`, `*_test.*`,
 * `test_*.*`) and any segment under a `test`/`tests`/`__tests__`/`spec`
 * directory. Case-insensitive on the filename token so `Foo.Test.ts` matches.
 */
export function isTestFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  // `foo.test.ts` / `foo.spec.tsx`.
  if (/\.(test|spec)\./i.test(base)) return true;
  // `handler_test.go` (`_test.`), `test_foo.py` (`^test_`), `a.test-utils.ts`
  // (`.test-`) — a `test` token bounded by a separator on the reference side.
  if (/(^|[._-])test[._-]/i.test(base)) return true;
  // Any segment under a test/tests/__tests__/spec directory.
  return /(^|\/)(tests?|__tests__|spec)\//i.test(normalized);
}

/**
 * Directory-name segments (lower-cased) that mark a documentation tree ONLY
 * when they sit at the repo-relative path's root. A `docs/`, `doc/`, or
 * `documentation/` directory nested inside source (e.g. a Java package named
 * `documentation`) is legitimate source, not a docs artifact, and must stay
 * seedable (#1003 follow-up).
 */
const ROOT_ANCHORED_DOC_DIRS = new Set(["docs", "doc", "documentation"]);

/**
 * Directory-name segments (lower-cased) that unambiguously mark a
 * documentation tree at **any** depth. Kept intentionally small: `xdoc` /
 * `xdocs` is Maven's Doxia site-documentation convention and has no
 * plausible meaning as a source package name.
 */
const DEPTH_INDEPENDENT_DOC_DIRS = new Set(["xdoc", "xdocs"]);

/**
 * Path heuristic for a documentation / marketing-site artifact that should be
 * excluded (or heavily demoted) from the requirement→code seed corpus (#1003).
 * Best-effort and path-based only — matches on directory-name **segments**,
 * never on file extension, so it never blanket-excludes `.xml`. Expects a
 * repo-relative path (leading `./` and `\` separators are normalized away).
 *
 *   - a root-anchored docs directory (`docs/`, `doc/`, `documentation/` as
 *     the FIRST path segment only) — a same-named directory nested deeper
 *     inside source is not excluded, since that shape is a plausible source
 *     package (e.g. `src/main/java/.../documentation/DocumentationService.java`);
 *   - `xdoc/` / `xdocs/` at any depth — Maven's Doxia site-documentation
 *     convention, unambiguous with no source-package meaning; and
 *   - the Maven website source tree `src/site/**`, anchored at the start of
 *     the path (the first two segments must be exactly `src`, `site`).
 *
 * `javadoc` was deliberately dropped from this heuristic: it cannot be
 * scoped unambiguously (a `javadoc` package/directory name is plausible
 * source, e.g. a doclet or javadoc-tooling module) and there is no safe
 * generated-output-only anchor for it, so retaining recall wins.
 *
 * `OrderMapper.xml` / `LineItemMapper.xml` and other MyBatis mapper XML live
 * under resource/mapper directories (e.g. `.../mapper/OrderMapper.xml`) and
 * are deliberately **not** matched by any rule here — they carry the SQL
 * statements the schema-crossing depends on and must stay fully seedable.
 */
export function isDocumentationFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .map((s) => s.toLowerCase());
  if (segments.length === 0) return false;

  // Root-anchored docs directory: only the FIRST segment counts.
  if (ROOT_ANCHORED_DOC_DIRS.has(segments[0])) return true;

  // `xdoc`/`xdocs` — Maven Doxia site-documentation convention, any depth.
  if (segments.some((s) => DEPTH_INDEPENDENT_DOC_DIRS.has(s))) return true;

  // `src/site/**` — Maven Doxia website source tree, anchored at path start.
  return segments[0] === "src" && segments[1] === "site";
}
