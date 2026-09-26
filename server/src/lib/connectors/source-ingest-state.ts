/**
 * Issue #182 — the recorded outcome of a repository-source RAG ingest.
 *
 * Before #182 the only record was a `connector.repo.source-ingest` audit row
 * written AFTER the ingest loop returned, so an ingest interrupted part-way left
 * nothing behind: onyourleft's index held 174 of ~860 eligible files and nothing
 * said so. The state is now written to `repo_connections.sourceIngestState` when
 * a run starts, heartbeated while it runs and settled when it ends, and
 * document generation reads it to warn when the index it grounds against is
 * partial.
 *
 * An interrupted run is recognised by its heartbeat going stale rather than by a
 * startup sweep: ingest runs inside request handlers on any replica, so one
 * instance restarting says nothing about another instance's live run.
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import type { DocWarning } from "../docs-gen/grounding/degraded-warnings.js";

const log = createChildLogger("connector-source-ingest-state");

export type SourceIngestStatus = "running" | "completed" | "partial" | "failed";
/** What a reader sees: a `running` state whose heartbeat went stale is `interrupted`. */
export type EffectiveSourceIngestStatus = SourceIngestStatus | "interrupted";

export interface SourceIngestSkipped {
  /** Selected by order but past `REPO_SOURCE_MAX_FILES`. */
  cap: number;
  /**
   * Larger than `REPO_SOURCE_MAX_FILE_BYTES`. #217: reported on the connector
   * (with the paths in `skippedPaths.tooLarge`), not a gap — see `settledStatus`.
   */
  tooLarge: number;
  /** Could not be stat'ed or read. */
  unreadable: number;
  /** Test/spec/fixture files left out by `REPO_SOURCE_INCLUDE_TESTS=false` (policy, not a gap). */
  excludedTests: number;
  /**
   * #217 — lockfiles and minified bundles left out by policy (not a gap). Absent
   * from states recorded before #217.
   */
  excludedGenerated?: number;
}

export interface SourceIngestState {
  version: 1;
  runId: string;
  status: SourceIngestStatus;
  startedAt: string;
  /** Refreshed while the run makes progress; a stale one means the run died. */
  heartbeatAt: string;
  finishedAt: string | null;
  /** Files that pass the extension allowlist and junk filter. */
  eligible: number;
  /** Files this run set out to embed (eligible minus every skip). */
  selected: number;
  /** Selected files attempted so far. */
  processed: number;
  created: number;
  updated: number;
  /** Already indexed with identical content — skipped by checksum. */
  unchanged: number;
  failed: number;
  chunkCount: number;
  skipped: SourceIngestSkipped;
  /** #217 — which files were skipped as oversize (first {@link SKIPPED_PATHS_RECORDED}). */
  skippedPaths?: { tooLarge: string[] };
  limits: { maxFiles: number; maxFileBytes: number; includeTests: boolean };
  /** Reduced error message for a `failed` run. */
  error?: string;
}

/**
 * A `running` state whose heartbeat is older than this is reported as
 * `interrupted`. The heartbeat is refreshed after every file, and the largest
 * file the default ceiling admits (1 MiB, ~500 chunks) embeds in a few minutes
 * on the in-process model, so ten minutes of silence means the process is gone.
 */
export const SOURCE_INGEST_STALE_MS = 10 * 60 * 1000;

/** How many oversize paths the state records for the connector view. */
export const SKIPPED_PATHS_RECORDED = 20;

/** Indexed so far: new, re-embedded, and unchanged files. */
export function indexedCount(state: SourceIngestState): number {
  return state.created + state.updated + state.unchanged;
}

export function parseSourceIngestState(raw: string | null | undefined): SourceIngestState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SourceIngestState>;
    if (value?.version !== 1 || typeof value.status !== "string") return null;
    return value as SourceIngestState;
  } catch {
    return null;
  }
}

export function effectiveSourceIngestStatus(
  state: SourceIngestState,
  now: number = Date.now(),
): EffectiveSourceIngestStatus {
  // #217 — a state recorded `partial` under the #209 policy only for oversize
  // files outlives the policy change; re-derive rather than trust the stored
  // status, so the connector view and document warnings agree.
  if (state.status === "partial") return settledStatus(state);
  if (state.status !== "running") return state.status;
  const beat = Date.parse(state.heartbeatAt);
  return Number.isFinite(beat) && now - beat <= SOURCE_INGEST_STALE_MS ? "running" : "interrupted";
}

/**
 * Settled status of a finished run: `partial` whenever a file the run should
 * have indexed is missing — past the budget, unreadable, or failed to embed.
 *
 * #217 decision: a file over `REPO_SOURCE_MAX_FILE_BYTES` is NOT a gap. It is
 * almost always generated (a bundle, a data dump, a vendored build), it is
 * skipped by an explicit operator setting, and under #209 one such file made
 * every document generated against the repository `degraded` — a warning on
 * every document that says nothing about the document. It is reported instead:
 * counted in `skipped.tooLarge`, listed in `skippedPaths.tooLarge` on the
 * connector's `sourceIngest`, and logged by path. Policy exclusions (tests,
 * lockfiles, minified bundles) are not gaps either.
 */
export function settledStatus(state: SourceIngestState): "completed" | "partial" {
  const { cap, unreadable } = state.skipped;
  return cap + unreadable + state.failed > 0 ? "partial" : "completed";
}

/**
 * Persist the state. Best-effort: recording the outcome must never be the thing
 * that fails an ingest, so a write error is logged, not thrown.
 */
export async function writeSourceIngestState(
  connectorId: string,
  state: SourceIngestState,
): Promise<void> {
  try {
    await prisma.repoConnection.update({
      where: { id: connectorId },
      data: { sourceIngestState: JSON.stringify(state) },
    });
  } catch (err) {
    log.warn("could not record repository source-ingest state", {
      connectorId,
      status: state.status,
      err: (err as Error).message,
    });
  }
}

/** Why a connector's index is partial, in one sentence, or null when it is complete. */
export function describeIndexGap(
  state: SourceIngestState | null,
  now: number = Date.now(),
): string | null {
  if (!state) {
    return (
      "its coverage was never recorded (it was indexed before METIS recorded ingest " +
      "outcomes, and older ingests stopped at the first 200 files and skipped files over 64 KB)"
    );
  }
  const status = effectiveSourceIngestStatus(state, now);
  const indexed = indexedCount(state);
  const counts = `${indexed} of ${state.eligible} eligible source file(s) are indexed`;
  if (status === "completed") return null;
  if (status === "running") return `an ingest is still running: ${counts} so far`;
  if (status === "interrupted") {
    return `the last ingest was interrupted after ${state.processed} of ${state.selected} file(s): ${counts}`;
  }
  if (status === "failed") return `the last ingest failed: ${counts}`;
  const reasons: string[] = [];
  if (state.skipped.cap > 0) {
    reasons.push(`${state.skipped.cap} past the REPO_SOURCE_MAX_FILES limit`);
  }
  if (state.skipped.unreadable > 0) reasons.push(`${state.skipped.unreadable} unreadable`);
  if (state.failed > 0) reasons.push(`${state.failed} failed to embed`);
  return `${counts} (${reasons.join(", ")})`;
}

interface RepoStateRow {
  id: string;
  label: string;
  sourceIngestState: string | null;
}

/**
 * Document-level warnings for every repository whose index is partial. A
 * document must never look grounded against source its retrieval could not
 * reach, so a partial (capped, failed, interrupted, still running, or never
 * recorded) index makes the document `degraded`.
 *
 * `repoConnectorId` narrows to the repository the document is generated for;
 * otherwise every repository connector of the project is checked, because
 * grounding retrieval searches the whole project index.
 */
export async function repositoryIndexWarnings(
  projectId: string,
  repoConnectorId?: string,
  now: number = Date.now(),
): Promise<DocWarning[]> {
  let rows: RepoStateRow[];
  try {
    rows = await prisma.repoConnection.findMany({
      where: {
        projectId,
        deletedAt: null,
        ...(repoConnectorId ? { id: repoConnectorId } : {}),
      },
      select: { id: true, label: true, sourceIngestState: true },
    });
  } catch (err) {
    log.warn("could not read repository source-ingest state for grounding", {
      projectId,
      err: (err as Error).message,
    });
    return [];
  }
  const warnings: DocWarning[] = [];
  for (const row of rows) {
    const gap = describeIndexGap(parseSourceIngestState(row.sourceIngestState), now);
    if (!gap) continue;
    warnings.push({
      kind: "source-unavailable",
      section: "Document",
      message:
        `The search index for repository "${row.label}" is incomplete: ${gap}. Sections were ` +
        `grounded only against the indexed files, so statements about the rest of the code ` +
        `could not be checked. Re-sync the repository, then regenerate.`,
      severity: "warning",
    });
  }
  return warnings;
}

/**
 * The API view of a connector's latest source ingest: the state plus its effective status.
 * Consumers must read `effectiveStatus`, not the raw stored `status` (#217: a legacy
 * `partial` row can be `completed` in effect, and a stale `running` one `interrupted`).
 */
export function sourceIngestSummary(
  raw: string | null | undefined,
  now: number = Date.now(),
): (SourceIngestState & { effectiveStatus: EffectiveSourceIngestStatus; indexed: number }) | null {
  const state = parseSourceIngestState(raw);
  if (!state) return null;
  return {
    ...state,
    effectiveStatus: effectiveSourceIngestStatus(state, now),
    indexed: indexedCount(state),
  };
}
