/**
 * JUnit round-trip service tests — Epic #260 / issue #45.
 *
 * Validates name-matching of JUnit testcases to TestCaseDoc rows, propagation
 * of pass/fail/skip into CoverageMapping.lastResult for the active run, and the
 * upload summary (matched / updated / unmatched / ambiguous / byStatus).
 *
 * The service is exercised against an in-memory fake of the Prisma surface it
 * touches, so no DB is required.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyJunitResults,
  normaliseTestName,
} from "../../../src/lib/testcoverage/junit-roundtrip.js";
import type { JunitTestResult } from "../../../src/lib/testcoverage/junit-parser.js";

interface FakeDoc {
  id: string;
  title: string;
}
interface FakeMapping {
  id: string;
  testCaseDocId: string;
  requirementId: string;
  lastResult?: string | null;
  lastResultAt?: Date | null;
  lastResultRunRef?: string | null;
}

function makeFakePrisma(docs: FakeDoc[], mappings: FakeMapping[]) {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  return {
    updates,
    prisma: {
      testCaseDoc: {
        findMany: vi.fn(async () => docs),
      },
      coverageMapping: {
        updateMany: vi.fn(
          async (args: {
            where: { testCaseDocId: { in: string[] }; runId: string };
            data: Record<string, unknown>;
          }) => {
            const ids = args.where.testCaseDocId.in;
            const matched = mappings.filter((m) => ids.includes(m.testCaseDocId));
            for (const m of matched) Object.assign(m, args.data);
            updates.push({ where: args.where, data: args.data });
            return { count: matched.length };
          },
        ),
      },
    },
  };
}

const RESULTS: JunitTestResult[] = [
  { name: "Logs in with valid creds", status: "passed" },
  { name: "rejects bad password", status: "failed", message: "401 expected" },
  { name: "SSO flow", status: "skipped" },
  { name: "totally unknown case", status: "passed" },
];

describe("normaliseTestName", () => {
  it("lowercases, trims, and collapses non-alphanumerics", () => {
    expect(normaliseTestName("  Logs IN  with-valid_creds! ")).toBe("logs in with valid creds");
  });
  it("strips a classname/method prefix separator", () => {
    expect(normaliseTestName("auth.LoginTest#logs in")).toBe(normaliseTestName("logs in"));
  });
});

describe("applyJunitResults", () => {
  it("matches by normalised name and propagates verdicts to mappings", async () => {
    const docs: FakeDoc[] = [
      { id: "tc-1", title: "Logs in with valid creds" },
      { id: "tc-2", title: "Rejects bad password" },
      { id: "tc-3", title: "SSO flow" },
    ];
    const mappings: FakeMapping[] = [
      { id: "m-1", testCaseDocId: "tc-1", requirementId: "r-1" },
      { id: "m-2", testCaseDocId: "tc-2", requirementId: "r-2" },
      { id: "m-3", testCaseDocId: "tc-3", requirementId: "r-3" },
    ];
    const { prisma, updates } = makeFakePrisma(docs, mappings);

    const summary = await applyJunitResults({
      prisma: prisma as never,
      projectId: "proj-1",
      runId: "run-1",
      results: RESULTS,
      runRef: "import-99",
    });

    expect(summary.total).toBe(4);
    expect(summary.matched).toBe(3);
    expect(summary.unmatched).toEqual(["totally unknown case"]);
    expect(summary.byStatus).toEqual({ passed: 2, failed: 1, skipped: 1 });
    expect(summary.updated).toBe(3);

    expect(mappings.find((m) => m.id === "m-1")?.lastResult).toBe("PASSED");
    expect(mappings.find((m) => m.id === "m-2")?.lastResult).toBe("FAILED");
    expect(mappings.find((m) => m.id === "m-3")?.lastResult).toBe("SKIPPED");
    expect(mappings.find((m) => m.id === "m-1")?.lastResultRunRef).toBe("import-99");

    // Batched: one updateMany per distinct verdict (3 here), NOT one per
    // matched testcase. Each call targets a set of doc-ids via `{ in: [...] }`.
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      const where = u.where as { testCaseDocId: { in: string[] }; runId: string };
      expect(where.runId).toBe("run-1");
      expect(Array.isArray(where.testCaseDocId.in)).toBe(true);
    }
    expect(prisma.coverageMapping.updateMany).toHaveBeenCalledTimes(3);
  });

  it("reports an ambiguous testcase when two docs share a normalised name", async () => {
    const docs: FakeDoc[] = [
      { id: "tc-a", title: "Login" },
      { id: "tc-b", title: "login" },
    ];
    const mappings: FakeMapping[] = [{ id: "m-a", testCaseDocId: "tc-a", requirementId: "r-1" }];
    const { prisma } = makeFakePrisma(docs, mappings);

    const summary = await applyJunitResults({
      prisma: prisma as never,
      projectId: "proj-1",
      runId: "run-1",
      results: [{ name: "Login", status: "passed" }],
    });

    expect(summary.matched).toBe(0);
    expect(summary.ambiguous).toEqual(["Login"]);
    expect(summary.updated).toBe(0);
  });

  it("counts a matched case with no mapping as matched-but-not-updated", async () => {
    const docs: FakeDoc[] = [{ id: "tc-1", title: "Orphan case" }];
    const { prisma } = makeFakePrisma(docs, []); // no mappings
    const summary = await applyJunitResults({
      prisma: prisma as never,
      projectId: "proj-1",
      runId: "run-1",
      results: [{ name: "orphan case", status: "passed" }],
    });
    expect(summary.matched).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.unmatched).toEqual([]);
  });

  it("batches same-verdict matches into one updateMany and sums the updated count", async () => {
    const docs: FakeDoc[] = [
      { id: "tc-1", title: "Has mapping A" },
      { id: "tc-2", title: "Has mapping B" },
      { id: "tc-3", title: "No mapping" },
    ];
    // tc-3 is matched but has no CoverageMapping row.
    const mappings: FakeMapping[] = [
      { id: "m-1", testCaseDocId: "tc-1", requirementId: "r-1" },
      { id: "m-2", testCaseDocId: "tc-2", requirementId: "r-2" },
    ];
    const { prisma, updates } = makeFakePrisma(docs, mappings);

    const summary = await applyJunitResults({
      prisma: prisma as never,
      projectId: "proj-1",
      runId: "run-1",
      results: [
        { name: "has mapping a", status: "passed" },
        { name: "has mapping b", status: "passed" },
        { name: "no mapping", status: "passed" },
      ],
    });

    // All three matched; only one updateMany (single verdict) covering all ids.
    expect(summary.matched).toBe(3);
    expect(updates).toHaveLength(1);
    expect(prisma.coverageMapping.updateMany).toHaveBeenCalledTimes(1);
    const where = updates[0].where as { testCaseDocId: { in: string[] } };
    expect(where.testCaseDocId.in).toEqual(["tc-1", "tc-2", "tc-3"]);
    // Only 2 mappings actually written, so `updated` is the summed count (2),
    // not the matched count (3).
    expect(summary.updated).toBe(2);
  });

  it("handles an empty result list", async () => {
    const { prisma } = makeFakePrisma([], []);
    const summary = await applyJunitResults({
      prisma: prisma as never,
      projectId: "proj-1",
      runId: "run-1",
      results: [],
    });
    expect(summary).toMatchObject({ total: 0, matched: 0, updated: 0 });
    expect(summary.unmatched).toEqual([]);
  });
});
