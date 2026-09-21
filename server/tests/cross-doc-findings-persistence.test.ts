/**
 * Tests for cross-document findings persistence (Issue #221).
 *
 * Verifies the Prisma round-trip: `persistCrossDocFindings()` writes one row
 * per finding (replacing any prior set) and `readCrossDocFindings()` returns
 * the normalised, surfaced bundle (or null when detection never ran).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrossDocFinding } from "@metis/shared";

interface Row {
  id: string;
  analysisId: string;
  kind: string;
  severity: string;
  title: string;
  detail: string;
  evidenceIds: string;
  scope: string | null;
  createdAt: Date;
}

const rows = new Map<string, Row>();
let seq = 0;
let clock = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    crossDocFinding: {
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        for (const [id, r] of rows) if (r.analysisId === where.analysisId) rows.delete(id);
        return { count: 0 };
      }),
      create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
        const row: Row = {
          id: `cdf_${++seq}`,
          createdAt: new Date(2026, 0, 1, 0, 0, ++clock),
          ...data,
        };
        rows.set(row.id, row);
        return row;
      }),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { analysisId: string };
          orderBy?: { createdAt: "asc" | "desc" };
        }) => {
          const list = [...rows.values()].filter((r) => r.analysisId === where.analysisId);
          list.sort((a, b) =>
            orderBy?.createdAt === "desc"
              ? b.createdAt.getTime() - a.createdAt.getTime()
              : a.createdAt.getTime() - b.createdAt.getTime(),
          );
          return list;
        },
      ),
    },
    // Issue #448 — read-time evidence enrichment batch-resolves evidenceIds to
    // Finding rows. These fixtures use synthetic doc ids with no Finding rows,
    // so the lookup returns [] and the bundle gracefully degrades to raw ids.
    finding: {
      findMany: vi.fn(
        async () => [] as Array<{ id: string; title: string; evidence: string | null }>,
      ),
    },
  },
}));

const { persistCrossDocFindings, readCrossDocFindings } =
  await import("../src/lib/analysis/analysis-service.js");

const FINDINGS: CrossDocFinding[] = [
  {
    id: "ignored-1",
    kind: "contradiction",
    severity: "high",
    title: "Latency contradiction",
    detail: "Premise: 200ms\nHypothesis: 5s",
    evidenceIds: ["docA", "docB"],
    scope: "pairwise",
  },
  {
    id: "ignored-2",
    kind: "missing-nfr",
    severity: "medium",
    title: "No availability target",
    detail: "No uptime SLA documented.",
    evidenceIds: ["docA"],
    scope: null,
  },
];

describe("cross-doc findings persistence", () => {
  beforeEach(() => {
    rows.clear();
    seq = 0;
    clock = 0;
  });

  it("returns null when no detection has run", async () => {
    expect(await readCrossDocFindings("ana1")).toBeNull();
  });

  it("persists one row per finding and reads back the normalised bundle", async () => {
    const ids = await persistCrossDocFindings({ analysisId: "ana1", findings: FINDINGS });
    expect(ids).toHaveLength(2);

    const bundle = await readCrossDocFindings("ana1");
    expect(bundle).not.toBeNull();
    expect(bundle!.findings).toHaveLength(2);
    expect(bundle!.contradictionCount).toBe(1);
    expect(bundle!.completenessGapCount).toBe(1);

    const contradiction = bundle!.findings.find((f) => f.kind === "contradiction");
    expect(contradiction!.evidenceIds).toEqual(["docA", "docB"]);
    expect(contradiction!.scope).toBe("pairwise");
    // Issue #448 — no Finding rows back these synthetic ids, so the read-time
    // enrichment degrades gracefully: no `evidence` field, raw ids preserved.
    expect(contradiction!.evidence).toBeUndefined();

    const gap = bundle!.findings.find((f) => f.kind === "missing-nfr");
    expect(gap!.scope).toBeNull();
    // The persisted db id (not the input id) is surfaced.
    expect(gap!.id).toMatch(/^cdf_/);
    expect(bundle!.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("replaces the prior set on re-run (no orphan rows)", async () => {
    await persistCrossDocFindings({ analysisId: "ana1", findings: FINDINGS });
    await persistCrossDocFindings({
      analysisId: "ana1",
      findings: [FINDINGS[0]!],
    });
    const bundle = await readCrossDocFindings("ana1");
    expect(bundle!.findings).toHaveLength(1);
    expect(bundle!.findings[0]!.kind).toBe("contradiction");
  });

  it("scopes reads by analysisId", async () => {
    await persistCrossDocFindings({ analysisId: "ana1", findings: FINDINGS });
    await persistCrossDocFindings({ analysisId: "ana2", findings: [FINDINGS[1]!] });
    expect((await readCrossDocFindings("ana1"))!.findings).toHaveLength(2);
    expect((await readCrossDocFindings("ana2"))!.findings).toHaveLength(1);
  });

  it("coerces an unknown persisted kind/scope to safe defaults on read", async () => {
    await persistCrossDocFindings({
      analysisId: "ana3",
      findings: [
        {
          id: "x",
          kind: "contradiction",
          severity: "high",
          title: "t",
          detail: "d",
          evidenceIds: [],
          scope: "pairwise",
        },
      ],
    });
    // Corrupt the row to simulate a legacy/bad value.
    const row = [...rows.values()].find((r) => r.analysisId === "ana3")!;
    row.kind = "garbage";
    row.scope = "garbage";
    const bundle = await readCrossDocFindings("ana3");
    expect(bundle!.findings[0]!.kind).toBe("contradiction"); // safe default
    expect(bundle!.findings[0]!.scope).toBeNull(); // invalid scope → null
  });
});
