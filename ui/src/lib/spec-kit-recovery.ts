/**
 * #1069 — recover a Spec Kit command whose response was lost.
 *
 * A command holds its request open for a whole model call. When the proxy or
 * the network gives up first, the browser sees a bare 5xx ("Internal Server
 * Error") or a failed fetch while the server goes on to save the artifact. So
 * the versions are read before the command, and after a lost response they are
 * read again for a bounded period: a newer artifact is shown as the result.
 * Stopgap for #1059, which makes the commands background jobs.
 */
import type { SpecKitNamespacedCommand } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import {
  specKitApi,
  type SpecKitCommandResult,
  type SpecKitFeature,
  type SpecKitRunOptions,
} from "@/lib/spec-kit-api";

/** Shown when the response was lost and no newer artifact appeared in time. */
export const SPEC_KIT_COMMAND_PENDING =
  "The command may still be running. Check again shortly: its result appears here once it is saved.";

/** The response was lost and polling found nothing: the outcome is unknown, not failed. */
export class SpecKitCommandPendingError extends Error {
  constructor() {
    super(SPEC_KIT_COMMAND_PENDING);
    this.name = "SpecKitCommandPendingError";
  }
}

/** Wait between two reads of the artifact versions. */
export const SPEC_KIT_RECOVERY_INTERVAL_MS = 5_000;
/** Reads before giving up: 36 × 5 s = 3 minutes. */
export const SPEC_KIT_RECOVERY_ATTEMPTS = 36;

/**
 * A lost response this soon after the command was sent is a failed send, not a
 * lost result: a refused connection or an API server that is down answers at
 * once, while the fastest command still waits on a model call. Such a failure
 * is shown as it is and nothing is polled. The cost of the threshold: a
 * connection that drops in its first 3 seconds reads as a failure even though
 * the command may run on.
 */
export const SPEC_KIT_FAILED_SEND_MS = 3_000;

/** The page was left while the command or its recovery was running. */
export class SpecKitCommandCancelledError extends Error {
  constructor() {
    super("The Spec Kit command was abandoned.");
    this.name = "SpecKitCommandCancelledError";
  }
}

const FEATURE_PREFIX = "feature:";

type Writes = (key: string) => boolean;
const only =
  (name: string): Writes =>
  (key) =>
    key === name;

/** `speckit.plan`'s outputs under `specs/<slug>/` (server: `plan-expanded.ts`). */
const PLAN_KEYS = new Set(["plan.md", "research.md", "data-model.md", "quickstart.md"]);

/**
 * What each command writes when it runs on a feature (keys under
 * `specs/<slug>/`). A command that is absent saves no artifact, so there is
 * nothing to poll for: `speckit.implement`, `speckit.taskstoissues`, and
 * `speckit.constitution`, which is never feature-scoped.
 */
const FEATURE_WRITES: Partial<Record<SpecKitNamespacedCommand, Writes>> = {
  "speckit.specify": only("spec.md"),
  "speckit.clarify": only("clarify.md"),
  "speckit.plan": (key) => PLAN_KEYS.has(key) || key.startsWith("contracts/"),
  "speckit.checklist": (key) => key.startsWith("checklist-"),
  "speckit.tasks": only("tasks.md"),
  "speckit.analyze": only("analysis.md"),
};

/**
 * What each command writes at project level: one `.specify/` file, or — for
 * `speckit.specify` alone — a feature. `speckit.plan` and `speckit.checklist`
 * need a feature, so they write nothing here.
 */
const PROJECT_WRITES: Partial<Record<SpecKitNamespacedCommand, Writes>> = {
  "speckit.constitution": only("constitution.md"),
  "speckit.specify": (key) => key.startsWith(FEATURE_PREFIX),
  "speckit.clarify": only("clarify.md"),
  "speckit.tasks": only("tasks.md"),
  "speckit.analyze": only("analysis.md"),
};

/**
 * The test for "this command wrote that key", or `null` when the command saves
 * no artifact in that scope. Recovery accepts only these: any other change —
 * a collaborator's edit, another tab's command — is not this command's result.
 */
export function commandWrites(
  command: SpecKitNamespacedCommand,
  featureSlug: string | undefined,
): Writes | null {
  return (featureSlug ? FEATURE_WRITES : PROJECT_WRITES)[command] ?? null;
}

/** Artifact key (or `feature:<slug>`) → version (or the feature's update time). */
export type ArtifactVersions = Record<string, number>;

/**
 * True when the command's outcome is unknown: the request never completed (a
 * failed `fetch` is a `TypeError`), or a 5xx came back without the server's
 * error envelope — the proxy's own "Internal Server Error". A 5xx that carries
 * an error code is the server reporting a failure it finished with, so it is
 * shown as it is.
 */
export function isLostResponse(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 && !err.code;
  return err instanceof TypeError;
}

/**
 * True when a lost response means the command never ran, so there is nothing
 * to wait for: the browser is offline, or the failure came back within
 * {@link SPEC_KIT_FAILED_SEND_MS} of sending.
 */
export function isFailedSend(elapsedMs: number): boolean {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return offline || elapsedMs < SPEC_KIT_FAILED_SEND_MS;
}

/** The keys that are new in `after`, or whose version is greater than in `before`. */
export function newerArtifacts(before: ArtifactVersions, after: ArtifactVersions): string[] {
  return Object.keys(after).filter((key) => {
    const was = before[key];
    return was === undefined || after[key]! > was;
  });
}

interface Snapshot {
  versions: ArtifactVersions;
  features: SpecKitFeature[];
}

/** The feature's artifacts, or — at project level — the project files and the feature list. */
async function readSnapshot(projectId: string, featureSlug: string | undefined): Promise<Snapshot> {
  if (featureSlug) {
    const { artifacts } = await specKitApi.listFeatureArtifacts(projectId, featureSlug);
    return {
      versions: Object.fromEntries(artifacts.map((a) => [a.key, a.version])),
      features: [],
    };
  }
  const [files, list] = await Promise.all([
    specKitApi.listFiles(projectId),
    specKitApi.listFeatures(projectId, false),
  ]);
  return {
    versions: {
      ...Object.fromEntries(files.artifacts.map((a) => [a.name, a.version])),
      ...Object.fromEntries(
        list.features.map((f) => [`${FEATURE_PREFIX}${f.slug}`, Date.parse(f.updatedAt) || 0]),
      ),
    },
    features: list.features,
  };
}

/**
 * A command result that points the page at what the lost command saved. It
 * says a newer artifact was saved, not that the command finished: the version
 * moved, and only this command's own outputs are looked at, but another
 * writer of the same artifact cannot be told apart.
 */
function recoveredResult(
  changed: string[],
  snapshot: Snapshot,
  featureSlug: string | undefined,
): SpecKitCommandResult {
  const message = (what: string): string =>
    `The command's response was lost, but a newer ${what} was saved. Showing it.`;
  const featureKey = changed.find((key) => key.startsWith(FEATURE_PREFIX));
  const feature = snapshot.features.find((f) => `${FEATURE_PREFIX}${f.slug}` === featureKey);
  if (feature) return { message: message(`feature "${feature.title}"`), feature };
  if (featureSlug) {
    return { message: message(changed.join(", ")), artifacts: changed.map((key) => ({ key })) };
  }
  return {
    message: message(changed[0]!),
    artifactName: changed[0] as SpecKitCommandResult["artifactName"],
  };
}

export interface SpecKitRecoveryTiming {
  intervalMs?: number;
  attempts?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The clock the failed-send threshold is measured on. */
  now?: () => number;
  /** Aborted when the page is left: no further read is made and no result is returned. */
  signal?: AbortSignal;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });

/**
 * Run a Spec Kit command; after a lost response, poll for the artifact it was
 * writing. Resolves with the command's own result, or with a result naming the
 * newer artifact. Rejects with the command's own error when the server
 * reported one or the send itself failed ({@link isFailedSend}), with
 * {@link SpecKitCommandPendingError} when the response was lost and nothing
 * newer appeared, and with {@link SpecKitCommandCancelledError} once
 * `timing.signal` aborts. The command itself is never resent.
 *
 * The versions are read once before the command is sent (one or two GETs). If
 * that read fails there is no baseline, so a lost response goes straight to
 * {@link SpecKitCommandPendingError} without polling.
 */
export async function runSpecKitCommandWithRecovery(
  projectId: string,
  command: SpecKitNamespacedCommand,
  options: SpecKitRunOptions = {},
  timing: SpecKitRecoveryTiming = {},
): Promise<SpecKitCommandResult> {
  const {
    intervalMs = SPEC_KIT_RECOVERY_INTERVAL_MS,
    attempts = SPEC_KIT_RECOVERY_ATTEMPTS,
    sleep = realSleep,
    now = Date.now,
    signal,
  } = timing;
  const writes = commandWrites(command, options.featureSlug);
  const read = (): Promise<Snapshot | null> =>
    readSnapshot(projectId, options.featureSlug).catch(() => null);
  const before = writes === null ? null : await read();
  const sentAt = now();
  try {
    return await specKitApi.runCommand(projectId, command, options);
  } catch (err) {
    if (!isLostResponse(err) || isFailedSend(now() - sentAt)) throw err;
    if (before !== null && writes !== null) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (signal?.aborted) throw new SpecKitCommandCancelledError();
        await sleep(intervalMs, signal);
        if (signal?.aborted) throw new SpecKitCommandCancelledError();
        const after = await read();
        const changed = after ? newerArtifacts(before.versions, after.versions).filter(writes) : [];
        if (after && changed.length > 0) {
          if (signal?.aborted) throw new SpecKitCommandCancelledError();
          return recoveredResult(changed, after, options.featureSlug);
        }
      }
    }
    throw new SpecKitCommandPendingError();
  }
}
