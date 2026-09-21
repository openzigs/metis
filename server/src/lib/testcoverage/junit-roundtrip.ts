/**
 * JUnit round-trip service (Epic #260, issue #45).
 *
 * Takes the normalised results of a {@link parseJUnitXml} call and reconciles
 * them against the project's `TestCaseDoc` corpus:
 *
 *   1. Each JUnit `<testcase>` name is normalised ({@link normaliseTestName})
 *      and matched against the normalised `TestCaseDoc.title`. Exact normalised
 *      match wins; a name that resolves to >1 doc is reported as `ambiguous`
 *      (never guessed); a name with no doc is reported as `unmatched`.
 *   2. For each matched doc, the JUnit verdict (PASSED/FAILED/SKIPPED) is
 *      propagated to every `CoverageMapping` for that doc in the active run via
 *      `lastResult` / `lastResultAt` / `lastResultRunRef`, so the linked
 *      requirement gains an execution-status badge (epic AC).
 *
 * Returns an upload summary in which unmatched (and ambiguous) test cases are
 * surfaced explicitly — the explicit acceptance criterion of #45.
 *
 * The service depends only on the narrow Prisma surface it touches so it can be
 * unit-tested against an in-memory fake (no DB).
 */
import type { JunitStatus, JunitTestResult } from "./junit-parser.js";

/** DB-mapping verdict stored on `CoverageMapping.lastResult`. */
export type CoverageVerdict = "PASSED" | "FAILED" | "SKIPPED";

const STATUS_TO_VERDICT: Record<JunitStatus, CoverageVerdict> = {
  passed: "PASSED",
  failed: "FAILED",
  skipped: "SKIPPED",
};

export interface JunitUploadSummary {
  readonly total: number;
  readonly matched: number;
  readonly updated: number;
  readonly unmatched: string[];
  readonly ambiguous: string[];
  readonly byStatus: { passed: number; failed: number; skipped: number };
}

/** The minimal Prisma surface this service needs (kept narrow for testing). */
export interface JunitRoundtripPrisma {
  testCaseDoc: {
    findMany(args: {
      where: { projectId: string };
      select: { id: true; title: true };
    }): Promise<Array<{ id: string; title: string }>>;
  };
  coverageMapping: {
    updateMany(args: {
      where: { testCaseDocId: { in: string[] }; runId: string };
      data: { lastResult: string; lastResultAt: Date; lastResultRunRef: string | null };
    }): Promise<{ count: number }>;
  };
}

export interface ApplyJunitInput {
  prisma: JunitRoundtripPrisma;
  projectId: string;
  /** Active coverage run whose mappings receive the verdict. */
  runId: string;
  results: ReadonlyArray<JunitTestResult>;
  /** Free-form reference recorded on each updated mapping (e.g. import id). */
  runRef?: string;
}

/**
 * Normalise a test name for matching: drop any `class.method#name` prefix,
 * lowercase, and collapse every run of non-alphanumerics to a single space.
 */
export function normaliseTestName(name: string): string {
  const noPrefix = name.includes("#") ? name.slice(name.lastIndexOf("#") + 1) : name;
  return noPrefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function applyJunitResults(input: ApplyJunitInput): Promise<JunitUploadSummary> {
  const { prisma, projectId, runId, results, runRef } = input;

  const docs = await prisma.testCaseDoc.findMany({
    where: { projectId },
    select: { id: true, title: true },
  });

  // Build a normalised-title -> doc-id(s) index so we can detect ambiguity.
  // NOTE: ambiguity is detected project-wide (across ALL of the project's
  // TestCaseDocs) — intentionally conservative so we never guess a match when
  // two docs share a normalised name. Verdicts, by contrast, are applied
  // run-scoped (filtered by `runId` below). Keep these two scopes distinct: a
  // future reader should NOT narrow the ambiguity index to the run, or a name
  // that is ambiguous project-wide could silently get a verdict for one run.
  const byName = new Map<string, string[]>();
  for (const doc of docs) {
    const key = normaliseTestName(doc.title);
    const list = byName.get(key) ?? [];
    list.push(doc.id);
    byName.set(key, list);
  }

  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const byStatus = { passed: 0, failed: 0, skipped: 0 };
  let matched = 0;
  let updated = 0;
  const now = new Date();

  // Group matched doc-ids by verdict so we can issue at most one updateMany per
  // status (PASSED/FAILED/SKIPPED) instead of one per matched testcase.
  const idsByVerdict: Record<CoverageVerdict, string[]> = {
    PASSED: [],
    FAILED: [],
    SKIPPED: [],
  };

  for (const r of results) {
    byStatus[r.status] += 1;
    const key = normaliseTestName(r.name);
    const docIds = byName.get(key) ?? [];
    if (docIds.length === 0) {
      unmatched.push(r.name);
      continue;
    }
    if (docIds.length > 1) {
      ambiguous.push(r.name);
      continue;
    }
    matched += 1;
    idsByVerdict[STATUS_TO_VERDICT[r.status]].push(docIds[0]);
  }

  // At most 3 updateMany calls — one per verdict. `updated` is the summed count
  // of mappings actually written, so a matched doc with no mapping still counts
  // as matched (above) but contributes 0 to `updated`.
  for (const verdict of Object.keys(idsByVerdict) as CoverageVerdict[]) {
    const ids = idsByVerdict[verdict];
    if (ids.length === 0) continue;
    const res = await prisma.coverageMapping.updateMany({
      where: { testCaseDocId: { in: ids }, runId },
      data: { lastResult: verdict, lastResultAt: now, lastResultRunRef: runRef ?? null },
    });
    updated += res.count;
  }

  return {
    total: results.length,
    matched,
    updated,
    unmatched,
    ambiguous,
    byStatus,
  };
}
