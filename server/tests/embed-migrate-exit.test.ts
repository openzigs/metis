/**
 * Issue #808 — `embeddings:migrate` exited 134 (SIGABRT) on a SUCCESSFUL run.
 *
 * A real reindex ran to completion (1,175/1,175 chunks embedded, "done"
 * printed) and then the process aborted:
 *
 *   libc++abi: terminating due to uncaught exception of type
 *   std::__1::system_error: mutex lock failed: Invalid argument
 *    ELIFECYCLE  Command failed with exit code 134.
 *
 * Root cause: `process.exit()` at the bottom of `scripts/embed-migrate.ts` races
 * onnxruntime-node's native teardown of a live inference session. Same class of
 * bug as #785 (`prefetch-embeddings-model.ts`, `embed-smoke.ts`); same fix:
 * `process.exitCode`, never `process.exit()`, so Node drains the event loop and
 * ORT releases its session before the process actually exits.
 *
 * The native mutex abort itself is racy and platform-dependent — it needs a
 * REAL ONNX session live on the native thread pool, which is not something a
 * fast, deterministic CI test can force on demand. What IS deterministic, and
 * what precisely distinguishes the pre-#808 source from the fix, is whether
 * `process.exit()` is ever invoked on `main()`'s resolution/rejection path.
 * `embed-migrate.ts` has no `isMainModule` guard — `main()` runs unconditionally
 * at module load, exactly as `pnpm embeddings:migrate` invokes it — so these
 * tests import the script fresh (via `vi.resetModules()` + dynamic `import()`,
 * the pattern already used by `tests/rag-embedder-offline.test.ts`), spy on
 * `process.exit`, and assert it is NEVER called.
 *
 * Empirically verified to FAIL on pre-fix `main` (commit before this PR): the
 * first test failed with
 *   "expected 'exit' to not be called ... Number of calls: 1"
 * before the `process.exitCode` fix landed. See the PR description for the
 * exact command + output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv;

function importFresh(argv: string[]): Promise<unknown> {
  vi.resetModules();
  process.argv = ["node", "embed-migrate.ts", ...argv];
  return import("../scripts/embed-migrate.js");
}

/** Let the `main().then()/.catch()` microtask chain settle after import. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("scripts/embed-migrate.ts exit-code contract — issue #808", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Stand-in for the real native abort: the pre-#808 script calls
    // `process.exit()` while an ONNX session may be live on the native thread
    // pool. We never invoke a REAL exit here (that would kill the test
    // worker) — the spy recording a call is itself the signal the buggy code
    // path leaves behind.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.exitCode = undefined;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.argv = originalArgv;
    process.exitCode = undefined;
    vi.doUnmock("../src/lib/rag/embed-migration.js");
    vi.resetModules();
  });

  it("a successful run (`help`) sets process.exitCode = 0 and NEVER calls process.exit()", async () => {
    await importFresh(["help"]);
    await flushMicrotasks();

    // This is the assertion that fails on pre-#808 `main`: the old code called
    // `process.exit(0)`, which this spy records.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("a genuine failure (unrecognized command) still exits non-zero, via exitCode not process.exit()", async () => {
    await importFresh(["not-a-real-command"]);
    await flushMicrotasks();

    // AC #3 — a real failure must still be reported as a failure. It must NOT
    // be papered over: exitCode is non-zero, exactly as `main()`'s `default:`
    // branch returns.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(process.exitCode).not.toBe(0);
  });

  it("a thrown error (the .catch path) sets exitCode = 1 without calling process.exit()", async () => {
    // Force `main()` to throw synchronously — before any command-specific
    // logic runs — by breaking `vectorStoreKind()`, which every non-`help`
    // command calls first. This exercises the SECOND call site fixed by
    // #808 (the `.catch()` handler), proving the fix didn't just move the bug
    // to the failure path.
    vi.doMock("../src/lib/rag/embed-migration.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/rag/embed-migration.js")>(
        "../src/lib/rag/embed-migration.js",
      );
      return {
        ...actual,
        vectorStoreKind: () => {
          throw new Error("simulated genuine failure (#808 regression check)");
        },
      };
    });

    await importFresh(["status"]);
    await flushMicrotasks();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(process.exitCode).not.toBe(0);
  });
});

/**
 * Issue #1182 — `status` distinguishes CHUNKER drift from MODEL drift by exit code.
 *
 * The codes encode whether the index is SERVING, not a severity ordering:
 *   1 — model/column drift: those rows are filtered out of retrieval, so the dense
 *       half of the index is dark for them. Remedy: reindex.
 *   3 — chunker drift only: the rows still rank, they just have the gaps #1178
 *       left. Remedy: RE-INGEST. A reindex re-embeds stored chunk text and moves
 *       no boundary, so conflating the two would prescribe a no-op.
 *
 * Before #1182 the third case exited 0 and printed "Up to date."
 */
describe("scripts/embed-migrate.ts — chunker-drift exit code (issue #1182)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.exitCode = undefined;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.argv = originalArgv;
    process.exitCode = undefined;
    vi.doUnmock("../src/lib/rag/embed-migration.js");
    vi.resetModules();
  });

  /**
   * Stub the decision layer (unit-tested in `embed-migration.test.ts`) so this test
   * covers only what it claims to: the CLI's mapping from plan to exit code.
   */
  function mockPlan(plan: { upToDate: boolean; projectsToReingest: string[] }): void {
    vi.doMock("../src/lib/rag/embed-migration.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/rag/embed-migration.js")>(
        "../src/lib/rag/embed-migration.js",
      );
      return {
        ...actual,
        defaultMigrationDeps: () => ({}),
        migrationStatus: () => Promise.resolve({}),
        planMigration: () => ({
          blocked: null,
          needsColumnMigration: false,
          projectsToReindex: [],
          steps: [],
          ...plan,
        }),
        formatStatus: () => "(stubbed status output)",
      };
    });
  }

  it("exits 3 when the ONLY outstanding work is a chunker drift", async () => {
    mockPlan({ upToDate: true, projectsToReingest: ["p-gappy"] });
    await importFresh(["status"]);
    await flushMicrotasks();

    expect(exitSpy).not.toHaveBeenCalled();
    // The assertion that fails on pre-#1182 `main`, which returned 0 here.
    expect(process.exitCode).toBe(3);
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).not.toBe(1);
  });

  it("exits 1 when a MODEL drift is outstanding, even alongside a chunker drift", async () => {
    // A dark index outranks a degraded one: the operator's first move is the
    // reindex, and 1 is the code every existing deploy gate already knows.
    mockPlan({ upToDate: false, projectsToReingest: ["p-gappy"] });
    await importFresh(["status"]);
    await flushMicrotasks();

    expect(process.exitCode).toBe(1);
  });

  it("exits 0 only when neither drift is outstanding", async () => {
    mockPlan({ upToDate: true, projectsToReingest: [] });
    await importFresh(["status"]);
    await flushMicrotasks();

    expect(process.exitCode).toBe(0);
  });
});
