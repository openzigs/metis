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

/** Commands that save no artifact, so there is nothing to poll for. */
const NO_ARTIFACT_COMMANDS: ReadonlySet<SpecKitNamespacedCommand> = new Set([
  "speckit.implement",
  "speckit.taskstoissues",
]);

const FEATURE_PREFIX = "feature:";

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

/** A command result that points the page at what the lost command saved. */
function recoveredResult(
  changed: string[],
  snapshot: Snapshot,
  featureSlug: string | undefined,
): SpecKitCommandResult {
  const message = (what: string): string =>
    `The command finished, but its response was lost. Showing the saved ${what}.`;
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
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a Spec Kit command; after a lost response, poll for the artifact it was
 * writing. Resolves with the command's own result, or with a result naming the
 * newer artifact. Rejects with the command's own error when the server
 * reported one, and with {@link SpecKitCommandPendingError} when the response
 * was lost and nothing newer appeared. The command itself is never resent.
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
  } = timing;
  const read = (): Promise<Snapshot | null> =>
    readSnapshot(projectId, options.featureSlug).catch(() => null);
  const before = NO_ARTIFACT_COMMANDS.has(command) ? null : await read();
  try {
    return await specKitApi.runCommand(projectId, command, options);
  } catch (err) {
    if (!isLostResponse(err)) throw err;
    if (before !== null) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await sleep(intervalMs);
        const after = await read();
        const changed = after ? newerArtifacts(before.versions, after.versions) : [];
        if (after && changed.length > 0) {
          return recoveredResult(changed, after, options.featureSlug);
        }
      }
    }
    throw new SpecKitCommandPendingError();
  }
}
