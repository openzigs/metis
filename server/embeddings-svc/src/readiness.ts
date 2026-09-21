/**
 * Warm-at-boot readiness for the embeddings sidecar (issue #786).
 *
 * ## The bug this fixes
 *
 * The chart has always pointed the sidecar's readinessProbe at `/readyz` —
 * a route the sidecar never implemented. Express answered it with the catch-all
 * 404, so the readiness probe could never pass, the pod could never become Ready,
 * and the `metis-embeddings` Service therefore had NO endpoints. (#783 added a
 * warm-at-boot `/readyz` to the SERVER; the sidecar never got one.)
 *
 * ## Why readiness has to mean "the ONNX session is warm"
 *
 * `getEmbedPipeline` is lazy: the first `/embed` request pays the whole cold
 * start — resolve weights from the baked cache, build the ONNX graph, allocate
 * the arena. Measured at the shipped q8 default that is ~0.2 s from a warm page
 * cache but seconds from cold storage on a fresh node. If readiness passed the
 * moment Express bound its port, Kubernetes would add the pod to the Service's
 * endpoints while it was still incapable of answering, and the first real
 * embed call — an ingest, not a probe — would eat the cold start (or time out
 * against `EMBEDDINGS_TIMEOUT_MS` and fail an ingest that had nothing wrong
 * with it).
 *
 * So: boot kicks off {@link beginWarmup}, `/readyz` reports `warming` (503)
 * until the session is built, and only then does the pod join the Service.
 *
 * ## Why a failed load must NOT exit the process
 *
 * A model that cannot load (missing baked weights under `HF_HUB_OFFLINE=1`,
 * a bad `EMBED_MODEL`) is a PERMANENT condition — restarting cannot fix it.
 * `process.exit(1)` would turn that into a CrashLoopBackOff, which hides the
 * logs behind restart backoff and tells you nothing the first line of the log
 * didn't. Instead the process stays up and honest: `/healthz` keeps returning
 * 200 (the process IS alive), `/readyz` returns 503 with the load error in the
 * body, the pod sits Running-but-NotReady, and the Deployment's rollout stalls
 * with the previous ReplicaSet still serving traffic.
 *
 * This is the same shape #783 gave the server's own embedder — deliberately.
 *
 * NOTE the division of labour with the probes (`deploy/helm/metis/values.yaml`):
 * `livenessProbe` must point at `/healthz`, NEVER at `/readyz`. Liveness asks
 * "is this process wedged?", and answering it with "has the model loaded?" is
 * what converts a stalled rollout into a crash-loop.
 */
import {
  resolveDtype,
  resolveEmbedModel,
  resolvePooling,
  type EmbedDtype,
  type EmbedPooling,
} from "./model-config.js";
import { getEmbedPipeline } from "./pipelines.js";

export type WarmupState = "warming" | "ready" | "error";

export interface ReadinessSnapshot {
  state: WarmupState;
  /** The model the sidecar warmed (or tried to warm) — what `/embed` serves by default. */
  model: string;
  dtype: EmbedDtype;
  pooling: EmbedPooling;
  /** Wall-clock ms the warm-up took (on success) or had taken when it failed. */
  durationMs?: number;
  /** Load failure message. Present only in the `error` state. */
  error?: string;
}

/** How a pipeline is loaded. Injectable so tests never touch onnxruntime. */
export type PipelineLoader = (model: string, dtype: EmbedDtype) => Promise<unknown>;

let snapshot: ReadinessSnapshot | null = null;
let inFlight: Promise<ReadinessSnapshot> | null = null;

/**
 * Start (once) the boot-time model load. Idempotent: repeated calls return the
 * same promise, so a second caller cannot start a second ONNX session.
 *
 * Never rejects — the failure is recorded in the snapshot and surfaced through
 * `/readyz`. An unhandled rejection at boot would kill the process, which is
 * exactly the crash-loop this function exists to avoid.
 */
export function beginWarmup(loader: PipelineLoader = getEmbedPipeline): Promise<ReadinessSnapshot> {
  if (inFlight) return inFlight;

  const model = resolveEmbedModel();
  const dtype = resolveDtype();
  const { pooling } = resolvePooling(model);
  const startedAt = Date.now();

  snapshot = { state: "warming", model, dtype, pooling };

  inFlight = loader(model, dtype)
    .then(() => {
      const durationMs = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.info(
        `[embeddings-svc] warm-up complete: model=${model} dtype=${dtype} pooling=${pooling} in ${durationMs}ms — /readyz now 200`,
      );
      snapshot = { state: "ready", model, dtype, pooling, durationMs };
      return snapshot;
    })
    .catch((err: unknown) => {
      const durationMs = Date.now() - startedAt;
      const error = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(
        `[embeddings-svc] warm-up FAILED after ${durationMs}ms: model=${model} dtype=${dtype}: ${error}\n` +
          "[embeddings-svc] the process stays UP and NOT-READY on purpose: restarting cannot fix a model that " +
          "will not load (missing baked weights under HF_HUB_OFFLINE=1, or a bad EMBED_MODEL). /readyz will keep " +
          "returning 503 so the rollout stalls and the previous pods keep serving.",
      );
      snapshot = { state: "error", model, dtype, pooling, durationMs, error };
      return snapshot;
    });

  return inFlight;
}

/**
 * Current readiness. `warming` BEFORE {@link beginWarmup} has been called too —
 * a process that never started warming has certainly not finished, and reporting
 * "ready" for it would be the exact lie this module exists to prevent.
 */
export function readinessSnapshot(): ReadinessSnapshot {
  if (snapshot) return snapshot;
  const model = resolveEmbedModel();
  const dtype = resolveDtype();
  return { state: "warming", model, dtype, pooling: resolvePooling(model).pooling };
}

/** Test seam — forget the warm-up so each test observes a fresh boot. */
export function __resetReadinessForTests(): void {
  snapshot = null;
  inFlight = null;
}
