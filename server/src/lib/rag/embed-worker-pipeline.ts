/**
 * Issue #189 — run the in-process ONNX feature-extraction pipeline in a
 * `worker_thread`, so model inference never blocks the server's event loop.
 *
 * ## Why the loop was blocked
 *
 * `onnxruntime-node` executes `InferenceSession.run` synchronously on the thread
 * that calls it — the binding wraps the native call in `setImmediate`, which only
 * moves the block to the next loop turn. `XenovaEmbedder` called it from the main
 * thread, so while a generated document embedded, `/healthz` and every API request
 * waited (a measured 5.2-minute `/api/auth/me`; the native stack sample showed the
 * main thread in `InferenceSessionWrap::Run` from `node::Environment::CheckImmediate`).
 *
 * ## Why a worker_thread, and not the embeddings sidecar
 *
 * The `sidecar` backend (`server/embeddings-svc`) already moves inference out of the
 * process and remains the recommended production topology. It is not the fix here:
 * it is a separate deployment an operator opts into, and the DEFAULT backend —
 * the one that hung — is in-process. A worker keeps the default's zero-deployment
 * property and moves only the model call: tokenisation, the forward pass and the
 * weights live in the worker, while `XenovaEmbedder`'s own logic (the #807
 * forward-batch policy, pooling, Matryoshka truncation, identity) stays exactly
 * where it was and is shared by both runtimes.
 *
 * ## Why the worker body is a string
 *
 * The worker must start under three runtimes: `node dist/…` (production), `tsx`
 * (dev) and vitest. A `.ts` worker entry cannot: tsx's loader hooks do not take
 * effect in worker threads on Node 22 (measured — `import "./x.js"` from a `.ts`
 * worker fails to resolve even when the parent runs under `tsx`), and `tsc` does not
 * copy a hand-written `.mjs` into `dist`. So the body below is plain JavaScript with
 * no project imports; it only `import()`s transformers.js by an absolute URL
 * resolved here. It is a compile-time constant — nothing from a request or the
 * environment is ever evaluated.
 *
 * ## Bounded concurrency
 *
 * One worker per pipeline; it serves one forward call at a time, in arrival order.
 * `XenovaEmbedder` posts one forward batch per call (a single text at the default
 * q8 dtype), so a query embedded by chat while a document is ingesting waits for at
 * most one forward pass rather than for the whole document.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("rag-embed-worker");

/** Where the in-process ONNX pipeline runs. */
export type InProcessEmbedRuntime = "worker" | "inline";

/**
 * `EMBED_INPROCESS_RUNTIME` — `worker` (default) or `inline`. `inline` restores the
 * pre-#189 behaviour; it exists for tests that mock `@huggingface/transformers`
 * in-process (a module mock does not cross a thread boundary). A typo throws, like
 * every other embedding knob: it must crashloop at boot, not quietly block the loop.
 */
export function resolveInProcessRuntime(
  env: Record<string, string | undefined> = process.env,
): InProcessEmbedRuntime {
  const raw = env.EMBED_INPROCESS_RUNTIME?.trim().toLowerCase();
  if (!raw) return "worker";
  if (raw === "worker" || raw === "inline") return raw;
  throw new Error(
    `Invalid EMBED_INPROCESS_RUNTIME "${env.EMBED_INPROCESS_RUNTIME}". Expected "worker" or "inline".`,
  );
}

/** The `env` fields of transformers.js the server sets (see `applyXenovaOfflineEnv`). */
export interface WorkerTransformersEnv {
  cacheDir?: string;
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  remoteHost?: string;
}

export interface WorkerPipelineOptions {
  model: string;
  dtype: string;
  /** Tokenizer truncation length applied in the worker (lower-only). */
  maxTokens: number;
  transformersEnv: WorkerTransformersEnv;
  /**
   * Absolute `file:` URL of the module exporting `{ pipeline, env }`. Defaults to
   * the installed `@huggingface/transformers`; tests substitute a deterministic
   * module. Set from code only.
   */
  moduleUrl?: string;
}

export interface WorkerTensor {
  data: Float32Array;
  dims: number[];
}

export interface WorkerPipeline {
  (texts: string | string[], opts: { pooling: string; normalize: boolean }): Promise<WorkerTensor>;
  /** Plain-JSON copy of the model config, for the pooling-mismatch check. */
  model: { config?: unknown };
  /** The effective tokenizer truncation length inside the worker (null: no tokenizer). */
  maxTokens: number | null;
  close(): Promise<void>;
}

type ReadyMessage =
  | { type: "ready"; maxTokens: number | null; config: unknown }
  | { type: "load-error"; error: string };
type RunResponse =
  | { id: number; ok: true; data: Float32Array; dims: number[] }
  | { id: number; ok: false; error: string };

/**
 * The worker body. Plain CommonJS-evaluated JavaScript: see the module header.
 * Mirrors `capTokenizerSequenceLength` (lower-only) and `applyXenovaOfflineEnv`
 * (only the fields the main thread resolved are assigned).
 */
export const EMBED_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  let pipe;
  try {
    const loaded = await import(workerData.moduleUrl);
    // A CommonJS build exposes its API on "default" only.
    const transformers = loaded.pipeline ? loaded : loaded.default;
    if (transformers.env) {
      for (const [key, value] of Object.entries(workerData.transformersEnv)) {
        if (value !== undefined) transformers.env[key] = value;
      }
    }
    pipe = await transformers.pipeline("feature-extraction", workerData.model, {
      dtype: workerData.dtype,
    });
    let maxTokens = null;
    const tokenizer = pipe.tokenizer;
    if (tokenizer) {
      const current = tokenizer.model_max_length;
      tokenizer.model_max_length =
        typeof current === "number" && Number.isFinite(current)
          ? Math.min(current, workerData.maxTokens)
          : workerData.maxTokens;
      maxTokens = tokenizer.model_max_length;
    }
    let config = null;
    try {
      config = JSON.parse(JSON.stringify((pipe.model && pipe.model.config) || null));
    } catch {}
    parentPort.postMessage({ type: "ready", maxTokens, config });
  } catch (err) {
    parentPort.postMessage({ type: "load-error", error: String((err && err.message) || err) });
    return;
  }
  let tail = Promise.resolve();
  parentPort.on("message", (msg) => {
    tail = tail.then(async () => {
      try {
        const tensor = await pipe(msg.texts, msg.opts);
        const data = Float32Array.from(tensor.data);
        parentPort.postMessage(
          { id: msg.id, ok: true, data, dims: Array.from(tensor.dims) },
          [data.buffer],
        );
      } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
      }
    });
  });
})();
`;

/**
 * Resolve the installed transformers.js to an absolute URL a worker can import —
 * the ESM build where the runtime can resolve it (node, tsx), else the `require`
 * build (the worker unwraps its `default`).
 */
export function resolveTransformersModuleUrl(
  resolveEsm: ((specifier: string) => string) | undefined = (
    import.meta as { resolve?: (specifier: string) => string }
  ).resolve,
): string {
  if (typeof resolveEsm === "function") {
    try {
      return resolveEsm("@huggingface/transformers");
    } catch {
      // Fall through to the CommonJS resolution.
    }
  }
  return pathToFileURL(createRequire(import.meta.url).resolve("@huggingface/transformers")).href;
}

/**
 * Start a worker, load the model inside it, and return a pipeline-shaped
 * function. Rejects with the worker's load error (so `XenovaEmbedder`'s
 * fail-loud / opt-in-fallback handling sees the same failure it always did).
 *
 * If the worker dies later (a native crash, an OOM kill of the thread), in-flight
 * calls reject and the NEXT call starts a fresh worker.
 */
export async function createWorkerPipeline(opts: WorkerPipelineOptions): Promise<WorkerPipeline> {
  const moduleUrl = opts.moduleUrl ?? resolveTransformersModuleUrl();
  let worker: Worker | null = null;
  let ready: Promise<Worker> | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve(r: RunResponse): void; reject(e: Error): void }>();
  const state: { maxTokens: number | null; config: unknown } = { maxTokens: null, config: null };

  const spawn = (): Promise<Worker> => {
    const w = new Worker(EMBED_WORKER_SOURCE, {
      eval: true,
      workerData: {
        moduleUrl,
        model: opts.model,
        dtype: opts.dtype,
        maxTokens: opts.maxTokens,
        transformersEnv: opts.transformersEnv,
      },
    });
    return new Promise<Worker>((resolve, reject) => {
      let loaded = false;
      const fail = (err: Error) => {
        if (worker === w) {
          worker = null;
          ready = null;
        }
        if (!loaded) reject(err);
        for (const [id, entry] of pending) {
          pending.delete(id);
          entry.reject(err);
        }
      };
      w.on("message", (message: ReadyMessage | RunResponse) => {
        if ("type" in message) {
          if (message.type === "load-error") {
            fail(new Error(message.error));
            void w.terminate();
            return;
          }
          loaded = true;
          state.maxTokens = message.maxTokens;
          state.config = message.config;
          // Never hold the process open on an idle model.
          w.unref();
          resolve(w);
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (pending.size === 0) w.unref();
        entry.resolve(message);
      });
      w.on("error", (err: Error) => {
        log.error("embed worker crashed", { model: opts.model, error: err.message });
        fail(err);
      });
      w.on("exit", (code) => fail(new Error(`embed worker exited (code ${code})`)));
      worker = w;
    });
  };

  const ensureReady = (): Promise<Worker> => {
    if (!ready) ready = spawn();
    return ready;
  };

  await ensureReady();
  log.info("embed worker ready", { model: opts.model, maxTokens: state.maxTokens });

  const run = async (
    texts: string | string[],
    runOpts: { pooling: string; normalize: boolean },
  ): Promise<WorkerTensor> => {
    const w = await ensureReady();
    const id = nextId++;
    const response = await new Promise<RunResponse>((resolve, reject) => {
      // Hold the process open only while work is outstanding, so a CLI that
      // awaits an embed cannot exit underneath it.
      if (pending.size === 0) w.ref();
      pending.set(id, { resolve, reject });
      w.postMessage({ id, texts, opts: runOpts });
    });
    if (!response.ok) throw new Error(response.error);
    return { data: response.data, dims: response.dims };
  };

  return Object.assign(run, {
    model: { config: state.config },
    maxTokens: state.maxTokens,
    close: async () => {
      const w = worker;
      worker = null;
      ready = null;
      if (w) await w.terminate();
    },
  }) as WorkerPipeline;
}
