/**
 * #399 — the completion text a Deep Ingest reports on the `job:lifecycle` bus.
 *
 * A run whose source-file or metadata ingest partly failed must not read like a
 * clean one: the same signals make the run skip automatic document
 * regeneration, so the user needs to know to run it again. The text carries
 * counts only — never an exception message, path or git output (#114, #254).
 */

export interface DeepIngestOutcome {
  codeGraph: {
    filesScanned: number;
    filesParsed: number;
    symbolsUpserted: number;
    edgesUpserted: number;
  };
  source: { documentsCreated: number; chunkCount: number; failures: number };
  /** `fetchFailed`: fetching or ingesting the metadata threw (counted as one failure). */
  metadata: { failures: number; fetchFailed: boolean };
  /** Size of the clone; 0 for local and upload sources, which clone nothing. */
  cloneSizeBytes: number;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The number of failures a run had; non-zero means regeneration was skipped. */
export function deepIngestFailureCount(outcome: DeepIngestOutcome): number {
  return (
    outcome.source.failures + outcome.metadata.failures + (outcome.metadata.fetchFailed ? 1 : 0)
  );
}

export function deepIngestCompletionMessage(outcome: DeepIngestOutcome): string {
  const { codeGraph, source, metadata, cloneSizeBytes } = outcome;
  const totals = [
    `${codeGraph.filesParsed} of ${codeGraph.filesScanned} files parsed`,
    plural(codeGraph.symbolsUpserted, "symbol"),
    plural(codeGraph.edgesUpserted, "edge"),
    plural(source.chunkCount, "RAG chunk"),
    `${plural(source.documentsCreated, "document")} created`,
  ];
  if (cloneSizeBytes > 0) totals.push(`${formatBytes(cloneSizeBytes)} cloned`);

  const failureCount = deepIngestFailureCount(outcome);
  if (failureCount === 0) return `Deep ingest complete: ${totals.join(", ")}.`;

  const failures: string[] = [];
  if (source.failures > 0)
    failures.push(`${plural(source.failures, "source file")} could not be ingested`);
  if (metadata.failures > 0)
    failures.push(
      `${plural(metadata.failures, "repository metadata document")} could not be ingested`,
    );
  if (metadata.fetchFailed) failures.push("repository metadata could not be fetched or ingested");

  return (
    `Deep ingest completed with ${plural(failureCount, "failure")}: ${failures.join("; ")}. ` +
    `Automatic document regeneration was skipped; run the ingest again to retry. ` +
    `${totals.join(", ")}.`
  );
}
