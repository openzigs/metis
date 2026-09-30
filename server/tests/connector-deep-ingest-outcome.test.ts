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
