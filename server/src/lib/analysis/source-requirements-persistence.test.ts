/**
 * Issue #1006 — the link between an analysis and the imported requirements it
 * was started from is written into the run's metadata at start and read back
 * through the snapshot the results page renders (write → read, same path).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisSourceRequirement } from "@metis/shared";

const store = vi.hoisted(() => ({ metadata: null as string | null }));
vi.mock("../finops/ledger-totals.js", () => ({ sumLedgerUsage: vi.fn(async () => null) }));
vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      create: vi.fn(async ({ data }: { data: { metadata: string } }) => {
        store.metadata = data.metadata;
        return { id: "an-1" };
      }),
      findFirst: vi.fn(async () => ({
        id: "an-1",
        projectId: "p-1",
        status: "completed",
        startedById: "u",
        startedAt: new Date("2026-10-09T00:00:00Z"),
        completedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        errorMessage: null,
        metadata: store.metadata,
        agentResults: [],
        requirements: [],
      })),
    },
    crossDocFinding: { findMany: vi.fn(async () => []) },
  },
  resolveDatabaseProvider: () => "sqlite",
}));

const { createAnalysis, getAnalysisSnapshot } = await import("./analysis-service.js");

const LINK: AnalysisSourceRequirement = {
  candidateId: "NR-1",
  requirementId: "req-3401",
  title: "Mark all entries of a category as read",
  externalSource: "github",
  externalId: "3401",
  externalUrl: "https://github.com/miniflux/v2/issues/3401",
};

const base = { projectId: "p-1", startedById: "u", agentKeys: ["code" as const] };

beforeEach(() => {
  store.metadata = null;
});

describe("analysis source requirements (#1006)", () => {
  it("reads back the imported requirements the run was started from", async () => {
    await createAnalysis({
      ...base,
      extraInstructions: `- ${LINK.title}`,
      sourceRequirements: [LINK],
    });
    const snap = await getAnalysisSnapshot("an-1");
    expect(snap?.sourceRequirements).toEqual([LINK]);
  });

  it("carries no key on a run not started from imported requirements", async () => {
    await createAnalysis({ ...base, extraInstructions: "Export OPML." });
    const snap = await getAnalysisSnapshot("an-1");
    expect(snap).not.toHaveProperty("sourceRequirements");
  });

  it("drops malformed entries from a hand-edited metadata blob", async () => {
    store.metadata = JSON.stringify({
      sourceRequirements: [LINK, { candidateId: "NR-2" }, "junk", null],
    });
    const snap = await getAnalysisSnapshot("an-1");
    expect(snap?.sourceRequirements).toEqual([LINK]);
  });
});
