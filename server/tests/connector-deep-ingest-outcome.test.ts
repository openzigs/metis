/**
 * #399 — the text a finished Deep Ingest reports on the `job:lifecycle` bus.
 *
 * A run whose source or metadata ingest partly failed used to read
 * "Deep ingest complete: …", indistinguishable from a clean run, even though the
 * same signals made it skip document regeneration.
 */
import { describe, expect, it } from "vitest";
import {
  deepIngestCompletionMessage,
  deepIngestFailureCount,
  deepIngestReportedFailureCount,
  syncFailureWarning,
  type DeepIngestOutcome,
} from "../src/lib/connectors/repo/deep-ingest-outcome.js";

const clean: DeepIngestOutcome = {
  codeGraph: { filesScanned: 12, filesParsed: 10, symbolsUpserted: 40, edgesUpserted: 25 },
  source: { documentsCreated: 7, chunkCount: 42, failures: 0 },
  metadata: { failures: 0, stepFailed: false },
  cloneSizeBytes: 3 * 1024 * 1024,
};

describe("deepIngestCompletionMessage (#399)", () => {
  it("reports a clean run as complete, with edges, documents and clone size", () => {
    expect(deepIngestCompletionMessage(clean)).toBe(
      "Deep ingest complete: 10 of 12 files parsed, 40 symbols, 25 edges, 42 RAG chunks, " +
        "7 documents created, 3.0 MB cloned.",
    );
  });

  it("omits the clone size when nothing was cloned (local and upload sources)", () => {
    const msg = deepIngestCompletionMessage({ ...clean, cloneSizeBytes: 0 });
    expect(msg).not.toContain("cloned");
    expect(msg).toMatch(/7 documents created\.$/);
  });

  it("formats small clone sizes in bytes and KB", () => {
    expect(deepIngestCompletionMessage({ ...clean, cloneSizeBytes: 512 })).toContain(
      "512 B cloned",
    );
    expect(deepIngestCompletionMessage({ ...clean, cloneSizeBytes: 2048 })).toContain(
      "2.0 KB cloned",
    );
  });

  it("says 'completed with N failures' and names source-file failures", () => {
    const msg = deepIngestCompletionMessage({
      ...clean,
      source: { ...clean.source, failures: 3 },
    });
    expect(msg).toMatch(/^Deep ingest completed with 3 failures: /);
    expect(msg).toContain("3 source files could not be ingested");
    expect(msg).not.toContain("Deep ingest complete:");
    expect(msg).toContain("Automatic document regeneration was skipped");
    // The totals still follow.
    expect(msg).toContain("42 RAG chunks");
  });

  it("uses the singular for one failure", () => {
    const msg = deepIngestCompletionMessage({
      ...clean,
      source: { ...clean.source, failures: 1 },
    });
    expect(msg).toMatch(/^Deep ingest completed with 1 failure: 1 source file could not/);
  });

  it("counts metadata document failures alongside source failures", () => {
    const msg = deepIngestCompletionMessage({
      ...clean,
      source: { ...clean.source, failures: 2 },
      metadata: { failures: 1, stepFailed: false },
    });
    expect(msg).toMatch(/^Deep ingest completed with 3 failures: /);
    expect(msg).toContain("2 source files could not be ingested");
    expect(msg).toContain("1 repository metadata document could not be ingested");
  });

  it("reports a metadata fetch or ingest that threw as one failure", () => {
    const msg = deepIngestCompletionMessage({
      ...clean,
      metadata: { failures: 0, stepFailed: true },
    });
    expect(msg).toMatch(/^Deep ingest completed with 1 failure: /);
    expect(msg).toContain("repository metadata could not be fetched or ingested");
    expect(msg).not.toContain("source file");
  });
});

describe("the code graph's size, apart from the run's delta (#715)", () => {
  // The #706 walkthrough: miniflux v2.3.3, a second ingest after the graph existed.
  const incremental: DeepIngestOutcome = {
    codeGraph: {
      filesScanned: 655,
      filesParsed: 42,
      symbolsUpserted: 689,
      edgesUpserted: 5936,
      filesUnchanged: 379,
      graphFiles: 421,
      graphSymbols: 3533,
      graphEdges: 26941,
    },
    source: { documentsCreated: 0, chunkCount: 2675, failures: 0 },
    metadata: { failures: 0, stepFailed: false },
    cloneSizeBytes: 5.9 * 1024 * 1024,
  };

  it("leads with the graph's totals and labels the re-parse as changed files", () => {
    expect(deepIngestCompletionMessage(incremental)).toBe(
      "Deep ingest complete: code graph of 421 files, 3533 symbols, 26941 edges " +
        "(42 changed files re-parsed, 379 unchanged), 2675 RAG chunks, " +
        "0 documents created, 5.9 MB cloned.",
    );
  });

  it("an unchanged re-ingest still reports the whole graph, never '0 of 655 files parsed'", () => {
    const msg = deepIngestCompletionMessage({
      ...incremental,
      codeGraph: {
        ...incremental.codeGraph,
        filesParsed: 0,
        symbolsUpserted: 0,
        edgesUpserted: 0,
        filesUnchanged: 421,
      },
    });
    expect(msg).toContain("code graph of 421 files, 3533 symbols, 26941 edges");
    expect(msg).toContain("(0 changed files re-parsed, 421 unchanged)");
    expect(msg).not.toContain("of 655");
  });

  it("uses the singular for one file", () => {
    expect(
      deepIngestCompletionMessage({
        ...incremental,
        codeGraph: {
          ...incremental.codeGraph,
          filesParsed: 1,
          filesUnchanged: 0,
          graphFiles: 1,
          graphSymbols: 1,
          graphEdges: 1,
        },
      }),
    ).toContain("code graph of 1 file, 1 symbol, 1 edge (1 changed file re-parsed, 0 unchanged)");
  });
});

describe("a scheduling warning (#449)", () => {
  const warning = "Scheduling regeneration failed; it is retried automatically.";

  it("completes with the warning and the totals, not as a clean run", () => {
    expect(deepIngestCompletionMessage({ ...clean, schedulingWarning: warning })).toBe(
      `Deep ingest completed with a warning: ${warning} 10 of 12 files parsed, 40 symbols, ` +
        "25 edges, 42 RAG chunks, 7 documents created, 3.0 MB cloned.",
    );
  });

  it("is reported as one failure, so the page styles it as a warning, but is not an ingest failure", () => {
    const outcome = { ...clean, schedulingWarning: warning };
    expect(deepIngestFailureCount(outcome)).toBe(0);
    expect(deepIngestReportedFailureCount(outcome)).toBe(1);
    expect(deepIngestReportedFailureCount(clean)).toBe(0);
  });
});

describe("syncFailureWarning (#498)", () => {
  const none = { source: { failures: 0 }, metadata: { failures: 0, stepFailed: false } };

  it("has no warning for a Sync with no ingest failures", () => {
    expect(syncFailureWarning(none)).toBeNull();
  });

  it("names every failure and says regeneration was skipped", () => {
    const warning = syncFailureWarning({
      source: { failures: 2 },
      metadata: { failures: 1, stepFailed: false },
    });
    expect(warning).toBe(
      "Sync completed with 3 failures: 2 source files could not be ingested; " +
        "1 repository metadata document could not be ingested. " +
        "Automatic document regeneration was skipped; run Sync again to retry.",
    );
  });

  it("counts a failed metadata step as one failure", () => {
    expect(syncFailureWarning({ ...none, metadata: { failures: 0, stepFailed: true } })).toMatch(
      /^Sync completed with 1 failure: repository metadata could not be fetched or ingested\./,
    );
  });
});
