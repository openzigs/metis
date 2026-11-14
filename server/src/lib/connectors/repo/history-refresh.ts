/**
 * #2338 — keep a connector's commit-history repository in step with its index
 * (ADR 0023). Every ingest that builds a code graph (Deep Ingest, Sync, the
 * unattended refresh) STARTS a refresh once the graph has recorded its commit
 * ({@link startConnectorHistoryRefresh}); it runs beside the rest of the
 * ingest and never delays it (#2484 review).
 *
 *   - `CHAT_CHANGE_HISTORY_TOOL` off: any history on disk is DELETED (the
 *     #2389 review: turning the tool off removes the commit text it kept);
 *   - a `local` / `upload` connector has no history to fetch;
 *   - the history is fetched at the graph's commit, the one the chat citations
 *     of #2325 name, so line ranges mean the same lines; a history already
 *     fetched at that commit and window is kept as it is, and one found too
 *     large is not downloaded again until its cap or window changes or
 *     {@link TOO_LARGE_RETRY_MS} has passed.
 *
 * Commit text can carry secrets and personal data, so history also goes with
 * its connector's project ({@link removeProjectHistories}), and a sweep at
 * boot and on every change of the flag removes any history the flag or a
 * live connector no longer accounts for ({@link sweepConnectorHistories}).
 *
 * Best effort: nothing here throws, so a history failure never fails an ingest.
 */
import type { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_PROVIDER_LOCAL, REPO_PROVIDER_UPLOAD } from "@metis/shared";
import { resolveRepoCloneRoot, resolveRepoHistoryPath } from "./clone-path.js";
import { getConfigService, type ConfigChangedEvent } from "../../config/config-service.js";
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import {
  CHANGE_HISTORY_FLAG,
  FULL_SHA_RE,
  hasHistoryRepository,
  readHistoryState,
  removeHistoryRepository,
  type HistoryFetchOutcome,
} from "./history-repo.js";

const log = createChildLogger("repo-history");

/** A history found too large is tried again after this long, cap and window unchanged. */
export const TOO_LARGE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

export type HistoryRefreshOutcome =
  | HistoryFetchOutcome
  | {
      status: "off" | "no_history_for_source" | "no_indexed_commit" | "unchanged" | "aborted";
    };

export interface HistoryLimits {
  windowDays: number;
  maxBytes: number;
}

export interface HistoryRefreshDeps {
  enabled?: () => boolean;
  fetch?: (
    projectId: string,
    id: string,
    commitSha: string,
    signal?: AbortSignal,
  ) => Promise<HistoryFetchOutcome>;
  /** The window and cap a fetch would use now. */
  limits?: () => Promise<HistoryLimits>;
  now?: () => Date;
  /** The ingest's cancellation (or {@link stopConnectorHistoryRefreshes}). */
  signal?: AbortSignal;
}

function flagOn(): boolean {
  return getConfigService().getBool(CHANGE_HISTORY_FLAG, false);
}

async function defaultFetch(
  projectId: string,
  id: string,
  commitSha: string,
  signal?: AbortSignal,
): Promise<HistoryFetchOutcome> {
  const { fetchConnectorHistory } = await import("./repo-service.js");
  return fetchConnectorHistory(projectId, id, commitSha, signal);
}

async function defaultLimits(): Promise<HistoryLimits> {
  const { resolveConnectorHistoryLimits } = await import("./repo-service.js");
  return resolveConnectorHistoryLimits();
}

export async function refreshConnectorHistory(
  projectId: string,
  connectorId: string,
  deps: HistoryRefreshDeps = {},
): Promise<HistoryRefreshOutcome> {
  try {
    const enabled = deps.enabled ?? flagOn;
    if (!enabled()) {
      if (await hasHistoryRepository(connectorId)) await removeHistoryRepository(connectorId);
      return { status: "off" };
    }
    if (deps.signal?.aborted) return { status: "aborted" };
    const conn = await prisma.repoConnection.findFirst({
      where: { id: connectorId, projectId, deletedAt: null },
      select: { provider: true },
    });
    if (!conn || conn.provider === REPO_PROVIDER_LOCAL || conn.provider === REPO_PROVIDER_UPLOAD) {
      return { status: "no_history_for_source" };
    }
    // The newest graph, as `loadCodeVersions` (which the tool compares against) reads it.
    const graph = await prisma.codeGraph.findFirst({
      where: { projectId, repoConnectionId: connectorId },
      select: { commitSha: true },
      orderBy: { lastIndexedAt: "desc" },
    });
    const commitSha = graph?.commitSha ?? null;
    if (!commitSha || !FULL_SHA_RE.test(commitSha)) return { status: "no_indexed_commit" };
    const limits = await (deps.limits ?? defaultLimits)();
    const state = await readHistoryState(connectorId);
    if (state?.status === "ready" && state.commitSha === commitSha) {
      const kept =
        state.windowDays === limits.windowDays &&
        state.sizeBytes <= limits.maxBytes &&
        (await fs.access(path.join(resolveRepoHistoryPath(connectorId), "HEAD")).then(
          () => true,
          () => false,
        ));
      if (kept) return { status: "unchanged" };
    }
    if (state?.status === "too_large") {
      // Downloading it again at every new commit would only measure it again
      // (#2484 review): wait for a new cap or window, or for the retry period.
      const age = (deps.now ?? (() => new Date()))().getTime() - Date.parse(state.fetchedAt);
      if (
        state.maxBytes === limits.maxBytes &&
        state.windowDays === limits.windowDays &&
        age >= 0 &&
        age < TOO_LARGE_RETRY_MS
      ) {
        return { status: "unchanged" };
      }
    }
    if (deps.signal?.aborted) return { status: "aborted" };
    const outcome = await (deps.fetch ?? defaultFetch)(
      projectId,
      connectorId,
      commitSha,
      deps.signal,
    );
    if (outcome.status === "ready") {
      log.info("Fetched repository commit history", {
        connectorId,
        sizeBytes: outcome.sizeBytes,
        prefetchedObjects: outcome.prefetchedObjects,
      });
    } else {
      log.warn("Repository commit history not kept", { connectorId, outcome });
    }
    return outcome;
  } catch (err) {
    log.warn("Repository commit history refresh failed", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "failed", reason: "history refresh failed" };
  }
}

// ---- running beside the ingest ---------------------------------------------

interface InFlight {
  controller: AbortController;
  /** Another ingest asked while this one ran: refresh once more when it ends. */
  again: { projectId: string } | null;
  done: Promise<void>;
}

const inFlight = new Map<string, InFlight>();

/**
 * Start refreshing `connectorId`'s history WITHOUT waiting for it: an ingest
 * calls this once its graph has recorded the commit, and goes on with the
 * knowledge ingest while the history downloads.
 *
 * One refresh per connector at a time; a request while one runs folds into a
 * single re-run when it ends (which reads the newest graph commit then).
 * Aborting `signal` (the ingest's cancellation), {@link cancelConnectorHistoryRefresh}
 * or {@link stopConnectorHistoryRefreshes} kills the running git call.
 *
 * The promise never rejects (every failure is an outcome, logged); callers
 * that do not wait for it discard it with `void`. Tests await it.
 */
export function startConnectorHistoryRefresh(
  projectId: string,
  connectorId: string,
  signal?: AbortSignal,
  deps: Omit<HistoryRefreshDeps, "signal"> = {},
): Promise<void> {
  const running = inFlight.get(connectorId);
  if (running) {
    running.again = { projectId };
    return running.done;
  }
  const controller = new AbortController();
  const relay = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", relay, { once: true });
  const entry: InFlight = { controller, again: null, done: Promise.resolve() };
  entry.done = (async () => {
    try {
      let next: { projectId: string } | null = { projectId };
      while (next && !controller.signal.aborted) {
        entry.again = null;
        await refreshConnectorHistory(next.projectId, connectorId, {
          ...deps,
          signal: controller.signal,
        });
        next = entry.again;
      }
    } catch (err) {
      // refreshConnectorHistory never throws; this is the last guard.
      log.warn("Repository commit history refresh crashed", {
        connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      signal?.removeEventListener("abort", relay);
      inFlight.delete(connectorId);
    }
  })();
  inFlight.set(connectorId, entry);
  return entry.done;
}

/** Stop `connectorId`'s running refresh, if any, and wait for it to end. */
export async function cancelConnectorHistoryRefresh(connectorId: string): Promise<void> {
  const running = inFlight.get(connectorId);
  if (!running) return;
  running.again = null;
  running.controller.abort();
  await running.done;
}

/** Shutdown: stop every running refresh and wait for them to end. */
export async function stopConnectorHistoryRefreshes(): Promise<void> {
  await Promise.allSettled([...inFlight.keys()].map((id) => cancelConnectorHistoryRefresh(id)));
}

/** Test-only: refreshes running now. */
export function __historyRefreshesInFlight(): number {
  return inFlight.size;
}

// ---- removal ----------------------------------------------------------------

/** Stop and remove `connectorId`'s history; logged, never thrown. */
export async function dropConnectorHistory(connectorId: string, why: string): Promise<void> {
  try {
    await cancelConnectorHistoryRefresh(connectorId);
    await removeHistoryRepository(connectorId);
  } catch (err) {
    log.warn("Failed to remove a repository connector's commit history", {
      connectorId,
      why,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Remove the history of every repository connector of `projectId`: a deleted
 * project's connectors are never deleted one by one, so their commit text
 * would otherwise stay on disk (#2484 review).
 */
export async function removeProjectHistories(projectId: string): Promise<number> {
  try {
    const rows = await prisma.repoConnection.findMany({
      where: { projectId },
      select: { id: true },
    });
    for (const r of rows) await dropConnectorHistory(r.id, "project deleted");
    return rows.length;
  } catch (err) {
    log.warn("Failed to remove a deleted project's commit histories", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

const HISTORY_ENTRY_RE = /^(.+)\.history\.(git|json)$/;

/**
 * Remove every history under the clone root that nothing accounts for: all of
 * them while the tool is off, otherwise those whose connector is gone,
 * deleted, or in a deleted project. Runs at boot and whenever the flag
 * changes, so turning the tool off removes the commit text at once rather
 * than at each connector's next ingest. Returns how many connectors' history
 * it removed; never throws.
 */
export async function sweepConnectorHistories(
  deps: { enabled?: () => boolean } = {},
): Promise<number> {
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(resolveRepoCloneRoot());
    } catch {
      return 0;
    }
    const ids = [
      ...new Set(
        entries.map((e) => HISTORY_ENTRY_RE.exec(e)?.[1]).filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) return 0;
    let stale = ids;
    if ((deps.enabled ?? flagOn)()) {
      const live = await prisma.repoConnection.findMany({
        where: { id: { in: ids }, deletedAt: null, project: { deletedAt: null } },
        select: { id: true },
      });
      const keep = new Set(live.map((r) => r.id));
      stale = ids.filter((id) => !keep.has(id));
    }
    for (const id of stale) await dropConnectorHistory(id, "sweep");
    if (stale.length > 0)
      log.info("Removed unaccounted repository commit histories", { count: stale.length });
    return stale.length;
  } catch (err) {
    log.warn("Repository commit history sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

let unsubscribe: (() => void) | null = null;

/**
 * Boot hook: sweep once, and again whenever `CHAT_CHANGE_HISTORY_TOOL`
 * changes. Never awaited by boot, never throws. Idempotent.
 */
export function startConnectorHistoryHousekeeping(
  opts: {
    /** The `config.changed` bus: the ConfigService (an EventEmitter) by default. */
    bus?: Pick<EventEmitter, "on" | "off">;
    enabled?: () => boolean;
  } = {},
): void {
  const svc: Pick<EventEmitter, "on" | "off"> = opts.bus ?? getConfigService();
  const sweep = (): void => {
    void sweepConnectorHistories(opts.enabled ? { enabled: opts.enabled } : {});
  };
  sweep();
  if (unsubscribe) unsubscribe();
  const handler = (evt: ConfigChangedEvent): void => {
    if (evt.key === CHANGE_HISTORY_FLAG) sweep();
  };
  svc.on("config.changed", handler);
  unsubscribe = () => {
    svc.off("config.changed", handler);
    unsubscribe = null;
  };
}
