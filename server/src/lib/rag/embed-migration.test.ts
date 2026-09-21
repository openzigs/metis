/**
 * Issue #787 — migration status / plan / bulk-reindex tests.
 *
 * The interesting behaviours here are the REFUSALS:
 *   - a broken or hash-fallen-back embedder BLOCKS the migration (reindexing onto
 *     a hash stub would rewrite the whole corpus with noise, and it would look
 *     like a successful model migration because the stub tags its own model id);
 *   - a pgvector column at the wrong width blocks it too, and the plan says so
 *     BEFORE listing any project, because no project can be reindexed until the
 *     column moves.
 * Plus the mixed-generation reporting the AC asks for, and the fact that one
 * failing project does not abort a bulk migration.
 */
import { describe, expect, it, vi } from "vitest";
import {
  formatLockStatus,
  formatStatus,
  migrationStatus,
  planMigration,
  prepareRefusal,
  reindexAll,
  retagRefusal,
  unlockRefusal,
  vectorStoreKind,
  type MigrationDeps,
  type MigrationStatus,
} from "./embed-migration.js";
import type { ReindexLeaseInfo } from "./reindex-lease.js";
import type { EmbedderHealth } from "./embedder.js";
import type { DeploymentCoverageReport, ReindexResult } from "./knowledge-service.js";
import type { VectorStore } from "./vector-store.js";

const NEW_MODEL = "Alibaba-NLP/gte-modernbert-base";
const OLD_MODEL = "Xenova/bge-small-en-v1.5";
/** #1182 — the chunker generation the active configuration produces. */
const CURRENT_CHUNKER = "doc:v2:2048/256";
/** #1182 — a superseded generation: same parameters, older algorithm. */
const OLD_CHUNKER = "doc:v1:2048/256";

function health(over: Partial<EmbedderHealth> = {}): EmbedderHealth {
  return {
    loaded: true,
    ok: true,
    status: "ok",
    backend: "sidecar",
    model: NEW_MODEL,
    dimension: 768,
    fellBack: false,
    hashFallbackAllowed: false,
    error: null,
    ...over,
  };
}

function coverage(over: Partial<DeploymentCoverageReport> = {}): DeploymentCoverageReport {
  return {
    currentModel: NEW_MODEL,
    currentDimension: 768,
    totalChunks: 0,
    modelCounts: {},
    totalSymbols: 0,
    symbolModelCounts: {},
    projects: [],
    projectsNeedingReindex: 0,
    // #1182 — the chunker half. Defaults describe a store with no chunks at all,
    // so a fixture that says nothing about chunking asserts nothing about it.
    currentChunkerIdentity: CURRENT_CHUNKER,
    chunkerCounts: {},
    projectsNeedingReingest: 0,
    ...over,
  };
}

/** #1182 — chunker fields for a project fixture that is NOT exercising chunker drift. */
function chunkerClean(totalChunks: number): {
  chunkerCounts: Record<string, number>;
  matchingChunkerChunks: number;
  needsReingest: boolean;
} {
  return {
    chunkerCounts: totalChunks > 0 ? { [CURRENT_CHUNKER]: totalChunks } : {},
    matchingChunkerChunks: totalChunks,
    needsReingest: false,
  };
}

const MIXED = coverage({
  totalChunks: 150,
  modelCounts: { [OLD_MODEL]: 100, [NEW_MODEL]: 50 },
  projects: [
    {
      projectId: "p-old",
      totalChunks: 100,
      matchingChunks: 0,
      modelCounts: { [OLD_MODEL]: 100 },
      totalSymbols: 0,
      matchingSymbols: 0,
      symbolModelCounts: {},
      needsReindex: true,
      ...chunkerClean(100),
    },
    {
      projectId: "p-new",
      totalChunks: 50,
      matchingChunks: 50,
      modelCounts: { [NEW_MODEL]: 50 },
      totalSymbols: 0,
      matchingSymbols: 0,
      symbolModelCounts: {},
      needsReindex: false,
      ...chunkerClean(50),
    },
  ],
  projectsNeedingReindex: 1,
});

function makeDeps(over: {
  health?: EmbedderHealth;
  coverage?: DeploymentCoverageReport;
  storedDimension?: number | null | (() => Promise<number | null>);
  reindexProject?: MigrationDeps["knowledge"]["reindexProject"];
  kind?: MigrationDeps["kind"];
}): MigrationDeps {
  const store = {} as VectorStore;
  if (over.storedDimension !== undefined) {
    store.storedDimension =
      typeof over.storedDimension === "function"
        ? over.storedDimension
        : async () => over.storedDimension as number | null;
  }
  return {
    knowledge: {
      deploymentCoverage: vi.fn().mockResolvedValue(over.coverage ?? coverage()),
      reindexProject: over.reindexProject ?? vi.fn(),
      reindexShadowState: vi.fn(),
      discardReindexShadow: vi.fn(),
    } as unknown as MigrationDeps["knowledge"],
    embedder: { health: vi.fn().mockResolvedValue(over.health ?? health()) },
    store,
    kind: over.kind ?? "lance",
  };
}

describe("vectorStoreKind", () => {
  it("mirrors getVectorStore()'s backend ladder", () => {
    expect(vectorStoreKind({ VECTOR_STORE: "pgvector" } as NodeJS.ProcessEnv)).toBe("pgvector");
    expect(vectorStoreKind({ VECTOR_STORE: "local" } as NodeJS.ProcessEnv)).toBe("local");
    // AI_OFFLINE wins regardless of VECTOR_STORE — same precedence as the factory.
    expect(
      vectorStoreKind({ AI_OFFLINE: "1", VECTOR_STORE: "pgvector" } as NodeJS.ProcessEnv),
    ).toBe("local");
    expect(vectorStoreKind({} as NodeJS.ProcessEnv)).toBe("lance");
  });
});

describe("migrationStatus", () => {
  it("reports a healthy, fully-migrated deployment as up to date", async () => {
    const status = await migrationStatus(
      makeDeps({
        coverage: coverage({
          totalChunks: 50,
          modelCounts: { [NEW_MODEL]: 50 },
          projects: [
            {
              projectId: "p-new",
              totalChunks: 50,
              matchingChunks: 50,
              modelCounts: { [NEW_MODEL]: 50 },
              totalSymbols: 0,
              matchingSymbols: 0,
              symbolModelCounts: {},
              needsReindex: false,
              ...chunkerClean(0),
            },
          ],
        }),
      }),
    );
    expect(status.store.needsColumnMigration).toBe(false);
    expect(planMigration(status).upToDate).toBe(true);
  });

  it("flags a pgvector column that is narrower than the active embedder", async () => {
    const status = await migrationStatus(
      makeDeps({ kind: "pgvector", storedDimension: 384, coverage: MIXED }),
    );
    expect(status.store).toMatchObject({
      kind: "pgvector",
      storedDimension: 384,
      needsColumnMigration: true,
    });
  });

  it("flags an EMPTY pgvector column at the wrong width — no chunks does not mean no problem", async () => {
    const status = await migrationStatus(
      makeDeps({ kind: "pgvector", storedDimension: 384, coverage: coverage() }),
    );
    expect(status.store.needsColumnMigration).toBe(true);
  });

  it("does not throw when the store's dimension cannot be read", async () => {
    const status = await migrationStatus(
      makeDeps({
        kind: "pgvector",
        storedDimension: () => Promise.reject(new Error("connection refused")),
      }),
    );
    expect(status.store.storedDimension).toBeNull();
    expect(status.store.needsColumnMigration).toBe(false);
  });

  it("reports no stored dimension for backends that have none", async () => {
    const status = await migrationStatus(makeDeps({ kind: "lance" }));
    expect(status.store.storedDimension).toBeNull();
    expect(status.store.needsColumnMigration).toBe(false);
  });
});

describe("planMigration", () => {
  it("orders the column migration BEFORE the per-project reindexes", async () => {
    const status = await migrationStatus(
      makeDeps({ kind: "pgvector", storedDimension: 384, coverage: MIXED }),
    );
    const plan = planMigration(status);

    expect(plan.upToDate).toBe(false);
    expect(plan.needsColumnMigration).toBe(true);
    expect(plan.projectsToReindex).toEqual(["p-old"]);
    expect(plan.steps[0]).toMatch(/pgvector column from 384d to 768d/);
    expect(plan.steps[1]).toMatch(/Reindex p-old/);
  });

  it("BLOCKS the migration when the embedder has fallen back to the hash stub", async () => {
    const status = await migrationStatus(
      makeDeps({
        health: health({
          ok: false,
          status: "degraded",
          fellBack: true,
          hashFallbackAllowed: true,
          error: "hash fallback active",
        }),
        coverage: MIXED,
      }),
    );
    const plan = planMigration(status);

    expect(plan.blocked).toMatch(/hash stub/);
    expect(plan.upToDate).toBe(false);
    // Crucially: it does NOT tell the operator to go reindex projects.
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatch(/^BLOCKED/);
  });

  it("BLOCKS the migration when the embedder cannot load at all", async () => {
    const status = await migrationStatus(
      makeDeps({
        health: health({ ok: false, status: "error", loaded: false, error: "sidecar unreachable" }),
        coverage: MIXED,
      }),
    );
    const plan = planMigration(status);
    expect(plan.blocked).toMatch(/sidecar unreachable/);
    expect(plan.steps[0]).toMatch(/^BLOCKED/);
  });

  it("says there is nothing to do when the corpus is empty and healthy", async () => {
    const plan = planMigration(await migrationStatus(makeDeps({})));
    expect(plan.upToDate).toBe(true);
    expect(plan.steps[0]).toMatch(/Nothing to do/);
  });
});

describe("reindexAll", () => {
  function result(projectId: string): ReindexResult {
    return {
      projectId,
      totalChunks: 10,
      reindexedChunks: 10,
      previousModels: [OLD_MODEL],
      currentModel: NEW_MODEL,
      currentDimension: 768,
      durationMs: 5,
      resumedChunks: 0,
      embeddedChunks: 10,
    };
  }

  it("reindexes only the projects that need it, sequentially", async () => {
    const order: string[] = [];
    const reindexProject = vi.fn(async (projectId: string) => {
      order.push(projectId);
      return result(projectId);
    }) as unknown as MigrationDeps["knowledge"]["reindexProject"];

    const deps = makeDeps({ coverage: MIXED, reindexProject });
    const out = await reindexAll(deps);

    expect(order).toEqual(["p-old"]);
    expect(out.results).toHaveLength(1);
    expect(out.failures).toHaveLength(0);
  });

  it("reindexes EVERY project when `all` is set", async () => {
    const reindexProject = vi.fn(async (projectId: string) =>
      result(projectId),
    ) as unknown as MigrationDeps["knowledge"]["reindexProject"];
    const out = await reindexAll(makeDeps({ coverage: MIXED, reindexProject }), { all: true });
    expect(out.results.map((r) => r.projectId)).toEqual(["p-old", "p-new"]);
  });

  it("keeps going after a project fails, and reports the failure", async () => {
    const reindexProject = vi.fn(async (projectId: string) => {
      if (projectId === "p-old") throw new Error("pod evicted");
      return result(projectId);
    }) as unknown as MigrationDeps["knowledge"]["reindexProject"];

    const out = await reindexAll(makeDeps({ coverage: MIXED, reindexProject }), { all: true });

    expect(out.failures).toEqual([{ projectId: "p-old", error: "pod evicted" }]);
    // The healthy project still migrated — one bad project does not stall the fleet.
    expect(out.results.map((r) => r.projectId)).toEqual(["p-new"]);
  });

  it("forwards batchSize / fresh and streams per-project progress", async () => {
    const seen: Array<{ projectId: string; processed: number; total: number }> = [];
    const reindexProject = vi.fn(
      async (projectId: string, opts: { onProgress?: (p: unknown) => void }) => {
        opts.onProgress?.({ processed: 5, total: 10 });
        return result(projectId);
      },
    ) as unknown as MigrationDeps["knowledge"]["reindexProject"];

    await reindexAll(makeDeps({ coverage: MIXED, reindexProject }), {
      batchSize: 32,
      fresh: true,
      onProgress: (projectId, processed, total) => seen.push({ projectId, processed, total }),
    });

    expect(reindexProject).toHaveBeenCalledWith(
      "p-old",
      expect.objectContaining({ batchSize: 32, fresh: true }),
    );
    expect(seen).toEqual([{ projectId: "p-old", processed: 5, total: 10 }]);
  });

  it("skips projects with no chunks", async () => {
    const reindexProject = vi.fn() as unknown as MigrationDeps["knowledge"]["reindexProject"];
    const empty = coverage({
      projects: [
        {
          projectId: "p-empty",
          totalChunks: 0,
          matchingChunks: 0,
          modelCounts: {},
          totalSymbols: 0,
          matchingSymbols: 0,
          symbolModelCounts: {},
          needsReindex: false,
          ...chunkerClean(0),
        },
      ],
    });
    await reindexAll(makeDeps({ coverage: empty, reindexProject }), { all: true });
    expect(reindexProject).not.toHaveBeenCalled();
  });
});

describe("formatStatus", () => {
  it("shows the per-model split during a mixed-generation state", async () => {
    const status: MigrationStatus = await migrationStatus(
      makeDeps({ kind: "pgvector", storedDimension: 384, coverage: MIXED }),
    );
    const text = formatStatus(status, planMigration(status));

    expect(text).toContain(NEW_MODEL);
    expect(text).toContain(OLD_MODEL);
    expect(text).toContain("67%"); // 100/150 still on the old model
    expect(text).toContain("<- active");
    expect(text).toContain("Projects needing reindex: 1/2");
    expect(text).toMatch(/MISMATCH: the column is 384d but the embedder emits 768d/);
  });

  it("shouts when the hash fallback is active", async () => {
    const status = await migrationStatus(
      makeDeps({ health: health({ ok: false, status: "degraded", fellBack: true }) }),
    );
    expect(formatStatus(status, planMigration(status))).toContain("HASH FALLBACK ACTIVE");
  });

  it("renders an empty deployment without dividing by zero", async () => {
    const status = await migrationStatus(makeDeps({}));
    const text = formatStatus(status, planMigration(status));
    expect(text).toContain("(no chunks indexed)");
    expect(text).toContain("Up to date.");
  });

  /**
   * #1361 — `needsReindex` unions chunk drift, symbol drift and queued work, but
   * the project line used to print the CHUNK ratio whatever the trigger was. A
   * project whose chunks were complete and whose SYMBOLS were behind rendered as
   * "1196/1196 on the active model" directly beside "needs reindex", which reads
   * as a flat contradiction and sends an operator to the wrong remedy.
   */
  it("reports the SYMBOL ratio when symbol drift is what flagged the project", async () => {
    const symbolDrift = coverage({
      totalChunks: 1196,
      modelCounts: { [NEW_MODEL]: 1196 },
      totalSymbols: 42792,
      symbolModelCounts: { "": 36904, [OLD_MODEL]: 5888 },
      projects: [
        {
          projectId: "p-symbols",
          totalChunks: 1196,
          matchingChunks: 1196,
          modelCounts: { [NEW_MODEL]: 1196 },
          totalSymbols: 42792,
          matchingSymbols: 0,
          symbolModelCounts: { "": 36904, [OLD_MODEL]: 5888 },
          needsReindex: true,
          ...chunkerClean(1196),
        },
      ],
      projectsNeedingReindex: 1,
    });
    const status = await migrationStatus(makeDeps({ coverage: symbolDrift }));
    const text = formatStatus(status, planMigration(status));

    const line = text.split("\n").find((l) => l.includes("p-symbols"));
    expect(line).toBeDefined();
    expect(line).toContain("symbols 0/42792");
    // The contradiction this issue is about: a FULL ratio offered as the reason
    // the project needs work.
    expect(line).not.toContain("1196/1196");
    // "" is a real sentinel (never embedded), not a blank model name.
    expect(line).toContain("pending — not embedded yet");
  });

  it("still reports the chunk ratio when chunk drift is the trigger", async () => {
    const status = await migrationStatus(makeDeps({ coverage: MIXED }));
    const line = formatStatus(status, planMigration(status))
      .split("\n")
      .find((l) => l.includes("p-old"));
    expect(line).toContain("chunks 0/100");
    expect(line).toContain(OLD_MODEL);
  });

  it("names queued work rather than printing a full ratio as the reason", async () => {
    const queued = coverage({
      totalChunks: 10,
      modelCounts: { [NEW_MODEL]: 10 },
      projects: [
        {
          projectId: "p-queued",
          totalChunks: 10,
          matchingChunks: 10,
          modelCounts: { [NEW_MODEL]: 10 },
          totalSymbols: 0,
          matchingSymbols: 0,
          symbolModelCounts: {},
          needsReindex: true,
          ...chunkerClean(10),
        },
      ],
      projectsNeedingReindex: 1,
    });
    const status = await migrationStatus(makeDeps({ coverage: queued }));
    const line = formatStatus(status, planMigration(status))
      .split("\n")
      .find((l) => l.includes("p-queued"));
    expect(line).toContain("queued but not yet applied");
    expect(line).not.toContain("10/10");
  });
});

/**
 * Issue #1182 — chunker-generation drift.
 *
 * Before this, a store holding both #1178 chunker generations was invisible:
 * every row carried the right `embeddingModel`, so `coverageReport` reported a
 * clean bill of health and `embeddings:migrate status` printed "Up to date." and
 * exited 0 over a corpus with gaps in it.
 *
 * The decision recorded in ADR 0006 is SERVE-DEGRADED (chunker-drifted rows keep
 * serving; they are never excluded from retrieval) plus OBSERVABLE (the drift is
 * reported distinctly, with its own exit code). These tests pin the "distinctly"
 * half — in particular that chunker drift never masquerades as a reindex, whose
 * remedy would do nothing.
 */
describe("issue #1182 — chunker drift is reported apart from model drift", () => {
  /** A store on the right MODEL throughout, but holding two chunker generations. */
  const CHUNKER_DRIFT = coverage({
    totalChunks: 100,
    modelCounts: { [NEW_MODEL]: 100 },
    chunkerCounts: { [CURRENT_CHUNKER]: 40, "": 60 },
    projects: [
      {
        projectId: "p-gappy",
        totalChunks: 100,
        matchingChunks: 100,
        modelCounts: { [NEW_MODEL]: 100 },
        totalSymbols: 0,
        matchingSymbols: 0,
        symbolModelCounts: {},
        // The model half is CLEAN. That is the whole point: nothing else in the
        // report would tell an operator anything is wrong.
        needsReindex: false,
        chunkerCounts: { [CURRENT_CHUNKER]: 40, "": 60 },
        matchingChunkerChunks: 40,
        needsReingest: true,
      },
    ],
    projectsNeedingReindex: 0,
    projectsNeedingReingest: 1,
  });

  it("lists the project under projectsToReingest and NOT under projectsToReindex", async () => {
    const status = await migrationStatus(makeDeps({ coverage: CHUNKER_DRIFT }));
    const plan = planMigration(status);
    expect(plan.projectsToReingest).toEqual(["p-gappy"]);
    // If this ever slipped into projectsToReindex, `reindex --all` would re-embed
    // the same gapped chunk text for hours and report success.
    expect(plan.projectsToReindex).toEqual([]);
  });

  it("prescribes a re-ingest, and says in words that a reindex will not do it", async () => {
    const status = await migrationStatus(makeDeps({ coverage: CHUNKER_DRIFT }));
    const step = planMigration(status).steps.join("\n");
    expect(step).toContain("Re-ingest p-gappy");
    expect(step).toMatch(/NOT a reindex/);
  });

  it("leaves `upToDate` alone — chunker drift is degraded, not dark", async () => {
    // `upToDate` is the exit-1 deploy gate and means "some rows are unretrievable".
    // Chunker-drifted rows still rank, so they must not trip it; the CLI gives them
    // exit 3 instead.
    const status = await migrationStatus(makeDeps({ coverage: CHUNKER_DRIFT }));
    expect(planMigration(status).upToDate).toBe(true);
  });

  it("formatStatus shows the generation split and refuses to say `Up to date.`", async () => {
    const status = await migrationStatus(makeDeps({ coverage: CHUNKER_DRIFT }));
    const text = formatStatus(status, planMigration(status));

    expect(text).toContain("Chunker       doc:v2:2048/256");
    // Untagged reads as "provenance unrecorded", not as "pre-#1178 with gaps":
    // since the panel found a second writer, an untagged row could be either.
    expect(text).toContain("(untagged — written before #1182, provenance unrecorded)");
    expect(text).toContain("60%"); // 60/100 untagged
    expect(text).toContain("Projects needing re-ingest: 1/1");
    expect(text).toContain("a reindex does NOT fix this");
    expect(text).toContain("p-gappy  40/100 on the active chunker");
    // The regression this whole issue exists to remove.
    expect(text).not.toContain("Up to date.");
  });

  it("distinguishes a superseded TAGGED generation from an untagged one", async () => {
    // Same parameters, older algorithm — the #1178 shape. A parameters-only tag
    // would render these two as the same value and report no drift at all.
    const tagged = coverage({
      totalChunks: 10,
      modelCounts: { [NEW_MODEL]: 10 },
      chunkerCounts: { [OLD_CHUNKER]: 10 },
      projects: [
        {
          projectId: "p-v1",
          totalChunks: 10,
          matchingChunks: 10,
          modelCounts: { [NEW_MODEL]: 10 },
          totalSymbols: 0,
          matchingSymbols: 0,
          symbolModelCounts: {},
          needsReindex: false,
          chunkerCounts: { [OLD_CHUNKER]: 10 },
          matchingChunkerChunks: 0,
          needsReingest: true,
        },
      ],
      projectsNeedingReingest: 1,
    });
    const status = await migrationStatus(makeDeps({ coverage: tagged }));
    const text = formatStatus(status, planMigration(status));
    expect(text).toContain(OLD_CHUNKER);
    expect(text).not.toContain("untagged");
    expect(planMigration(status).projectsToReingest).toEqual(["p-v1"]);
  });

  it("labels another producer's chunks as not-compared, and does not call them drift", async () => {
    // The panel's blocking finding, at the report layer: `docs-gen/rag-ingest.ts`
    // chunks must be visible to an operator without being counted as work.
    const withForeign = coverage({
      totalChunks: 100,
      modelCounts: { [NEW_MODEL]: 100 },
      chunkerCounts: { [CURRENT_CHUNKER]: 90, "docsgen:v1:1500": 10 },
      projects: [
        {
          projectId: "p-mixed",
          totalChunks: 100,
          matchingChunks: 100,
          modelCounts: { [NEW_MODEL]: 100 },
          totalSymbols: 0,
          matchingSymbols: 0,
          symbolModelCounts: {},
          needsReindex: false,
          chunkerCounts: { [CURRENT_CHUNKER]: 90, "docsgen:v1:1500": 10 },
          matchingChunkerChunks: 90,
          needsReingest: false,
        },
      ],
    });
    const status = await migrationStatus(makeDeps({ coverage: withForeign }));
    const plan = planMigration(status);
    const text = formatStatus(status, plan);

    expect(text).toContain("docsgen:v1:1500  (a different chunker — not compared)");
    expect(plan.projectsToReingest).toEqual([]);
    expect(text).toContain("Up to date.");
  });

  it("says nothing about re-ingest when every chunk is on the active generation", async () => {
    const status = await migrationStatus(
      makeDeps({
        coverage: coverage({
          totalChunks: 50,
          modelCounts: { [NEW_MODEL]: 50 },
          chunkerCounts: { [CURRENT_CHUNKER]: 50 },
          projects: [
            {
              projectId: "p-clean",
              totalChunks: 50,
              matchingChunks: 50,
              modelCounts: { [NEW_MODEL]: 50 },
              totalSymbols: 0,
              matchingSymbols: 0,
              symbolModelCounts: {},
              needsReindex: false,
              ...chunkerClean(50),
            },
          ],
        }),
      }),
    );
    const plan = planMigration(status);
    expect(plan.projectsToReingest).toEqual([]);
    expect(formatStatus(status, plan)).toContain("Up to date.");
  });

  it("still reports chunker drift while the embedder is BLOCKED", async () => {
    // The blocked branch returns early. It must still carry the chunker list, or a
    // deployment with both problems loses one of them the moment the other appears.
    const status = await migrationStatus(
      makeDeps({
        coverage: CHUNKER_DRIFT,
        health: health({ ok: false, status: "degraded", fellBack: true }),
      }),
    );
    const plan = planMigration(status);
    expect(plan.blocked).toBeTruthy();
    expect(plan.projectsToReingest).toEqual(["p-gappy"]);
  });
});

/**
 * PR #796 review (B1) — `prepare` is the DESTRUCTIVE command, and it was the one
 * command with no health gate.
 *
 * `reindex` refused when `planMigration()` reported `blocked`; `prepare` checked only
 * `needsColumnMigration` and `--force`. That inverts the risk: a column migration is
 * fleet-wide and NOT resumable, so it is more expensive to get wrong than a reindex,
 * not less. These are the states in which it must refuse to drop anything.
 */
describe("prepareRefusal — #796 review B1", () => {
  const pgStatus = async (over: Parameters<typeof makeDeps>[0] = {}): Promise<MigrationStatus> =>
    migrationStatus(makeDeps({ kind: "pgvector", storedDimension: 768, ...over }));

  it("REFUSES with --force while the embedder has fallen back to the hash stub", async () => {
    // The walk that costs a deployment every vector it has: the real backend failed to
    // warm, so `getEmbedder()` reports the STUB's 384-dim width, `needsColumnMigration`
    // goes true against the 768d column — correctly, it is a diagnostic — and
    // `prepare --force` then rebuilds the column at the HASH STUB's width.
    const status = await pgStatus({
      health: health({ status: "degraded", ok: false, fellBack: true, dimension: 384 }),
    });
    expect(status.store.needsColumnMigration).toBe(true); // the trap is armed...

    const refusal = prepareRefusal(status, { force: true }); // ...and --force does not spring it.
    expect(refusal).toMatch(/REFUSING to prepare/);
    expect(refusal).toMatch(/hash stub/);
  });

  it("REFUSES with --force while the embedder is in error", async () => {
    const status = await pgStatus({
      health: health({ status: "error", ok: false, error: "sidecar unreachable", dimension: 384 }),
    });
    const refusal = prepareRefusal(status, { force: true });
    expect(refusal).toMatch(/REFUSING to prepare/);
    expect(refusal).toMatch(/not usable/);
  });

  it("REFUSES a healthy migration without --force, and names the dump that makes rollback cheap", async () => {
    const status = await pgStatus({ storedDimension: 384 });
    const refusal = prepareRefusal(status, { force: false });
    expect(refusal).toMatch(/without --force/);
    expect(refusal).toMatch(/pg_dump/);
    // The dump is only worth taking because `retag` can now spend it (#796 review S2).
    expect(refusal).toMatch(/retag --force/);
  });

  it("ALLOWS a healthy, forced migration — the gate has no false positives", async () => {
    const status = await pgStatus({ storedDimension: 384 });
    expect(prepareRefusal(status, { force: true })).toBeNull();
  });
});

/**
 * PR #796 review (S2) — `retag` re-labels chunks WITHOUT re-embedding, which is the
 * missing half of the `pg_dump` rollback fast path. It is only ever correct straight
 * after restoring a dump taken while the active model was live, so it is gated harder
 * than `reindex`, not more loosely: in any other state it makes coverage LIE.
 */
describe("retagRefusal — #796 review S2", () => {
  it("REFUSES while the embedder is degraded — the tags would name the hash stub", async () => {
    const status = await migrationStatus(
      makeDeps({
        kind: "pgvector",
        storedDimension: 384,
        health: health({ status: "degraded", ok: false, fellBack: true, dimension: 384 }),
      }),
    );
    expect(retagRefusal(status, { force: true })).toMatch(/REFUSING to retag/);
  });

  it("REFUSES on a column-width mismatch — a mismatch PROVES the vectors are not this model's", async () => {
    const status = await migrationStatus(
      makeDeps({ kind: "pgvector", storedDimension: 384 }), // column 384, embedder 768
    );
    const refusal = retagRefusal(status, { force: true });
    expect(refusal).toMatch(/REFUSING to retag/);
    expect(refusal).toMatch(/width mismatch PROVES/);
  });

  it("REFUSES without --force, and points at reindex for operators who have NOT restored a dump", async () => {
    const status = await migrationStatus(makeDeps({ kind: "pgvector", storedDimension: 768 }));
    const refusal = retagRefusal(status, { force: false });
    expect(refusal).toMatch(/without --force/);
    expect(refusal).toMatch(/reindex --all/);
  });

  it("ALLOWS a forced retag once the widths agree and the embedder is healthy (the post-restore state)", async () => {
    const status = await migrationStatus(makeDeps({ kind: "pgvector", storedDimension: 768 }));
    expect(retagRefusal(status, { force: true })).toBeNull();
  });
});

/**
 * Issue #798 — the operator escape hatch's decision logic (`lock-status` / `unlock`).
 * The CLI wrapper is coverage-excluded, so the judgement it renders lives here.
 */
describe("#798 — lock-status / unlock", () => {
  function lease(over: Partial<ReindexLeaseInfo> = {}): ReindexLeaseInfo {
    return {
      projectId: "p1",
      holder: "metis-server-7d9f:9c1e-run",
      expiresAt: Date.now() + 60_000,
      updatedAt: Date.now() - 4_000,
      ageMs: 4_000,
      expired: false,
      ...over,
    };
  }

  it("reports 'no lease' plainly (and explains why a SQLite runtime never has one)", () => {
    const out = formatLockStatus("p1", null);
    expect(out).toMatch(/No reindex lease is held for p1/);
    expect(out).toMatch(/non-Postgres/);
  });

  it("a LIVE lease names the holder, its age, and says reindex/discard will 409", () => {
    const out = formatLockStatus("p1", lease());
    expect(out).toMatch(/metis-server-7d9f:9c1e-run/);
    expect(out).toMatch(/LIVE/);
    expect(out).toMatch(/409/);
  });

  it("an EXPIRED lease tells the operator they do NOT have to restart a pod", () => {
    const out = formatLockStatus("p1", lease({ expired: true, ageMs: 400_000 }));
    expect(out).toMatch(/EXPIRED/);
    expect(out).toMatch(/never have to restart a pod/);
    expect(out).toMatch(/embeddings:migrate unlock --project p1 --force/);
  });

  it("unlock: nothing held → nothing to refuse", () => {
    expect(unlockRefusal(null, { force: false })).toBeNull();
  });

  it("unlock: an EXPIRED lease may be cleared without --force (its holder is gone)", () => {
    expect(unlockRefusal(lease({ expired: true }), { force: false })).toBeNull();
  });

  it("unlock: a LIVE lease is REFUSED without --force, and the refusal names the holder", () => {
    const refusal = unlockRefusal(lease(), { force: false });
    expect(refusal).toMatch(/REFUSING to unlock/);
    expect(refusal).toMatch(/metis-server-7d9f:9c1e-run/);
    // It must be honest about the cost: fencing is safe, but the run is lost.
    expect(refusal).toMatch(/FENCES it/);
  });

  it("unlock: --force clears even a LIVE lease (the operator has been told the cost)", () => {
    expect(unlockRefusal(lease(), { force: true })).toBeNull();
  });
});
