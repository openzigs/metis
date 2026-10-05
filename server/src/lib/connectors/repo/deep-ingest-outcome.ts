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
    /**
     * #715 — the graph's size after the run, and the files an incremental run
     * left as they were. Optional only for a caller that does not have them;
     * without them the message falls back to the run's own counts.
     */
    filesUnchanged?: number;
    graphFiles?: number;
    graphSymbols?: number;
    graphEdges?: number;
  };
  source: { documentsCreated: number; chunkCount: number; failures: number };
  /**
   * `failures`: metadata documents that could not be ingested.
   * `stepFailed`: the metadata step as a whole threw — the fetch *or* the ingest —
   * so there is no per-document count; it counts as one failure. (Named
   * `fetchFailed` until #432, which undersold it: an ingest throw sets it too.)
   */
  metadata: { failures: number; stepFailed: boolean };
  /** Size of the clone; 0 for local and upload sources, which clone nothing. */
  cloneSizeBytes: number;
  /**
   * #449 — the ingest landed but scheduling regeneration failed: the warning to
   * report. The run still completes; it counts as one failure so the client
   * styles it as a warning.
   */
  schedulingWarning?: string;
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

/** The failure signals shared by Deep Ingest and Sync (refresh-ingest, #498). */
export interface IngestFailures {
  source: { failures: number };
  metadata: DeepIngestOutcome["metadata"];
}

/** The ingest failures a run had; non-zero means regeneration was skipped. */
export function deepIngestFailureCount(outcome: IngestFailures): number {
  return (
    outcome.source.failures + outcome.metadata.failures + (outcome.metadata.stepFailed ? 1 : 0)
  );
}

/** What the run reports as its `failureCount`: ingest failures plus a scheduling warning. */
export function deepIngestReportedFailureCount(outcome: DeepIngestOutcome): number {
  return deepIngestFailureCount(outcome) + (outcome.schedulingWarning ? 1 : 0);
}

export function deepIngestCompletionMessage(outcome: DeepIngestOutcome): string {
  const { codeGraph, source, metadata, cloneSizeBytes } = outcome;
  const totals = [
    describeCodeGraph(codeGraph),
    plural(source.chunkCount, "RAG chunk"),
    `${plural(source.documentsCreated, "document")} created`,
  ];
  if (cloneSizeBytes > 0) totals.push(`${formatBytes(cloneSizeBytes)} cloned`);

  const failureCount = deepIngestFailureCount(outcome);
  if (failureCount === 0 && outcome.schedulingWarning)
    return `Deep ingest completed with a warning: ${outcome.schedulingWarning} ${totals.join(", ")}.`;
  if (failureCount === 0) return `Deep ingest complete: ${totals.join(", ")}.`;

  return (
    `Deep ingest completed with ${plural(failureCount, "failure")}: ` +
    `${describeFailures({ source, metadata })}. ` +
    `Automatic document regeneration was skipped; run the ingest again to retry. ` +
    `${totals.join(", ")}.`
  );
}

/**
 * #715 — the graph's size first, then what this run changed. An incremental
 * run re-parses only files whose content changed, so its own counts ("42 of 655
 * files parsed, 689 symbols") read as most of the repository failing to parse.
 */
function describeCodeGraph(codeGraph: DeepIngestOutcome["codeGraph"]): string {
  const { graphFiles, graphSymbols, graphEdges, filesUnchanged } = codeGraph;
  if (graphFiles === undefined || graphSymbols === undefined || graphEdges === undefined) {
    return [
      `${codeGraph.filesParsed} of ${codeGraph.filesScanned} files parsed`,
      plural(codeGraph.symbolsUpserted, "symbol"),
      plural(codeGraph.edgesUpserted, "edge"),
    ].join(", ");
  }
  const delta = [`${plural(codeGraph.filesParsed, "changed file")} re-parsed`];
  if (filesUnchanged !== undefined) delta.push(`${filesUnchanged} unchanged`);
  return (
    `code graph of ${plural(graphFiles, "file")}, ${plural(graphSymbols, "symbol")}, ` +
    `${plural(graphEdges, "edge")} (${delta.join(", ")})`
  );
}

function describeFailures({ source, metadata }: IngestFailures): string {
  const failures: string[] = [];
  if (source.failures > 0)
    failures.push(`${plural(source.failures, "source file")} could not be ingested`);
  if (metadata.failures > 0)
    failures.push(
      `${plural(metadata.failures, "repository metadata document")} could not be ingested`,
    );
  if (metadata.stepFailed) failures.push("repository metadata could not be fetched or ingested");
  return failures.join("; ");
}

/**
 * #498 — the warning a Sync (refresh-ingest) returns when its ingest partly
 * failed, or `null` for a clean one. Counts only, as for Deep Ingest (#114).
 */
export function syncFailureWarning(failures: IngestFailures): string | null {
  const failureCount = deepIngestFailureCount(failures);
  if (failureCount === 0) return null;
  return (
    `Sync completed with ${plural(failureCount, "failure")}: ${describeFailures(failures)}. ` +
    `Automatic document regeneration was skipped; run Sync again to retry.`
  );
}
