import { timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { getEmbedPipeline, getRerankPipeline } from "./pipelines.js";
import {
  assertValidEmbedConfig,
  EMBED_POOLINGS,
  forwardBatches,
  MAX_EMBED_TEXT_CHARS,
  MAX_EMBED_TEXTS_PER_REQUEST,
  resolveDtype,
  resolveEmbedModel,
  resolvePooling,
} from "./model-config.js";
import { readinessSnapshot } from "./readiness.js";

const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

const embedSchema = z.object({
  /**
   * Issue #786 — capped at 64 (was 256). Peak memory scales with
   * `batch × longest-row-tokens` and the default model's context is 8192, so a
   * 256-row full-context request is an OOMKill, not a slow request. Rejected
   * LOUDLY rather than truncated: silently embedding 64 of the 256 texts a
   * caller sent would return fewer vectors than inputs, and the caller zips
   * vectors back onto chunks positionally.
   */
  texts: z
    .array(
      z
        .string()
        .min(1)
        /**
         * The count cap bounds the batch by CARDINALITY only — 64 × an arbitrarily
         * long string is still unbounded work. `express.json({ limit: "8mb" })`
         * caps the whole body, but 6 MB of text spread over 64 entries clears it
         * and reaches the tokenizer, which walks every byte before the model
         * truncates at 8192 tokens. Bound each entry too, so the request's cost is
         * bounded from both ends.
         */
        .max(MAX_EMBED_TEXT_CHARS, {
          message:
            `text too long: at most ${MAX_EMBED_TEXT_CHARS} characters per entry. ` +
            "The model truncates at 8192 tokens (~32k chars) anyway, so anything longer is " +
            "tokenizer work that can never reach the model. Chunk it first.",
        }),
    )
    .min(1)
    .max(MAX_EMBED_TEXTS_PER_REQUEST, {
      message:
        `too many texts: at most ${MAX_EMBED_TEXTS_PER_REQUEST} per /embed request. ` +
        "The batch is bounded because peak memory scales with batch × context (8192 tokens " +
        "for the default model). Split the input into ≤64-text requests — the METIS server's " +
        "EmbeddingsClient already does this for you.",
    }),
  model: z.string().min(1).optional(),
  /**
   * Issue #782 — optional pooling override. Omitted → resolved from the
   * per-model map (`cls` for gte-modernbert/Granite, `mean` for bge/jina/MiniLM).
   * An unknown value is a 400: silently falling back to `mean` is exactly the
   * failure mode this issue exists to kill.
   */
  pooling: z.enum(EMBED_POOLINGS).optional(),
});

const rerankSchema = z.object({
  query: z.string().min(1),
  candidates: z
    .array(
      z.object({
        chunkId: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .min(1)
    .max(256),
  model: z.string().min(1).optional(),
});

/**
 * Read the configured token. Missing/empty token = fail closed: every
 * authenticated request returns 503. This is intentional — running the
 * sidecar without a shared secret would allow any pod on the network to
 * generate embeddings against our compute budget.
 */
function readToken(): string | null {
  const raw = process.env.EMBEDDINGS_TOKEN;
  if (!raw || raw.trim().length === 0) return null;
  return raw.trim();
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = readToken();
  if (!expected) {
    res.status(503).json({
      error: "service_unavailable",
      message:
        "EMBEDDINGS_TOKEN is not configured — the sidecar refuses requests until a shared secret is set.",
    });
    return;
  }
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const presented = match?.[1]?.trim() ?? "";
  // Pad both sides to the same length to guarantee timingSafeEqual works.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  let ok = a.length === b.length;
  if (ok) {
    try {
      ok = timingSafeEqual(a, b);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function createApp(): Express {
  // Issue #782 — FAIL AT BOOT, NOT PER REQUEST. `resolvePooling`/`resolveDtype`
  // throw on a bad value, but they run inside the /embed handler's try block, so
  // a typo'd EMBED_POOLING_MAP would otherwise produce a pod that starts, passes
  // /healthz, takes traffic, and 500s on every embed. Validating here means the
  // process dies immediately and visibly instead. Per-request validation of the
  // `pooling` FIELD is unaffected — that stays a genuine 400 (see embedSchema).
  assertValidEmbedConfig();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));

  /**
   * LIVENESS. "Is this process alive and is its HTTP loop responsive?" — nothing
   * more. It deliberately does NOT consider whether the model has loaded.
   *
   * The chart points `livenessProbe` here (issue #786). Pointing liveness at
   * `/readyz` instead is the classic footgun: a model that cannot load would then
   * fail liveness, kubelet would kill the container, and a permanent, restart-proof
   * misconfiguration would present as a CrashLoopBackOff — losing the logs and the
   * ability to exec in. `ready` is reported here as an informational field, but it
   * never changes the status code.
   */
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "metis-embeddings",
      tokenConfigured: readToken() !== null,
      ready: readinessSnapshot().state === "ready",
    });
  });

  /**
   * READINESS — issue #786. 200 only once the boot-time ONNX session is warm.
   *
   * Until then (and forever, if the load failed) this is a 503, so Kubernetes
   * keeps the pod out of the `metis-embeddings` Service's endpoints and the first
   * real `/embed` call never pays the cold start. Unauthenticated by design:
   * kubelet does not carry `EMBEDDINGS_TOKEN`, and a probe that 503s for lack of
   * a bearer token would be indistinguishable from a probe that 503s because the
   * model is broken. It leaks nothing an operator's `describe pod` doesn't.
   *
   * Before #786 this route did not exist — the chart's readinessProbe hit the
   * catch-all 404, so the sidecar pod could never become Ready at all.
   *
   * OWASP A01/A09 — the wire body carries NO raw exception text. The loader's
   * error is logged in full (`readiness.ts`) and reported here only as a stable,
   * generic reason. A transformers.js / onnxruntime failure message routinely
   * contains filesystem paths, cache directories and the resolved HF endpoint,
   * and this route is unauthenticated ON PURPOSE (kubelet carries no
   * EMBEDDINGS_TOKEN) — so anything it returns is readable by anything that can
   * reach the pod network, which is a strictly larger set than "kubelet".
   * ClusterIP + the deny-default NetworkPolicy make that set small, but small is
   * not empty, and the operator's route to the detail is `kubectl logs`, which
   * they need anyway. `failed` vs `warming` is all a probe can act on.
   */
  app.get("/readyz", (_req, res) => {
    const snap = readinessSnapshot();
    res.status(snap.state === "ready" ? 200 : 503).json({
      status: snap.state,
      service: "metis-embeddings",
      model: snap.model,
      dtype: snap.dtype,
      pooling: snap.pooling,
      tokenConfigured: readToken() !== null,
      ...(snap.durationMs !== undefined ? { durationMs: snap.durationMs } : {}),
      ...(snap.error
        ? { error: "model failed to load — see the pod logs for the underlying error" }
        : {}),
    });
  });

  app.post("/embed", authMiddleware, async (req, res) => {
    const parsed = embedSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
      return;
    }
    // #784 — the default MUST come from `resolveEmbedModel` (i.e. `EMBED_MODEL`,
    // else `DEFAULT_SIDECAR_EMBED_MODEL`) and never from a literal here. It is
    // the same call the image build makes to decide what to bake, which is what
    // makes "the model this sidecar serves by default is in the baked cache" a
    // structural fact rather than a hope. A literal in this file was invisible to
    // the bake and would come back as an unbootable HF_HUB_OFFLINE=1 image.
    const { texts, model = resolveEmbedModel(), pooling: requested } = parsed.data;
    try {
      // Precedence: request > EMBED_POOLING_MAP > per-model map > EMBED_POOLING > "mean".
      const { pooling } = resolvePooling(model, requested);
      const dtype = resolveDtype();
      const pipe = await getEmbedPipeline(model, dtype);

      // #807 — the REQUEST still carries up to MAX_EMBED_TEXTS_PER_REQUEST texts
      // (the round-trip is still amortised), but the MODEL FORWARD is split by
      // `forwardBatches`. At a quantized dtype the ONNX graph's
      // `DynamicQuantizeLinear` nodes derive one per-tensor scale from the whole
      // batch, so a text's vector would otherwise depend on which other texts the
      // caller happened to send with it — measured at cos(batch-1, batch-64) =
      // 0.974, worth ~6 places of retrieval rank. Order is preserved.
      const vectors: number[][] = [];
      for (const batch of forwardBatches(texts, dtype)) {
        const tensor = await pipe(batch, { pooling, normalize: true });
        vectors.push(...tensorToVectors(tensor, batch.length));
      }
      const dimension = vectors[0]?.length ?? 0;
      // `pooling` + `dtype` are ADDITIVE response fields — older callers ignore them.
      res.json({ vectors, model, dimension, pooling, dtype });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[embeddings-svc] /embed failed", err);
      res.status(500).json({ error: "embed_failed", message: (err as Error).message ?? "unknown" });
    }
  });

  app.post("/rerank", authMiddleware, async (req, res) => {
    const parsed = rerankSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
      return;
    }
    const { query, candidates, model = DEFAULT_RERANK_MODEL } = parsed.data;
    try {
      const pipe = await getRerankPipeline(model);
      const pairs = candidates.map((c) => ({ text: query, text_pair: c.text }));
      const raw = (await pipe(pairs)) as Array<{ score?: number }>;
      const scores = candidates.map((_, i) => {
        const r = raw[i];
        return r && typeof r.score === "number" ? r.score : 0;
      });
      res.json({ scores, model });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[embeddings-svc] /rerank failed", err);
      res
        .status(500)
        .json({ error: "rerank_failed", message: (err as Error).message ?? "unknown" });
    }
  });

  // Reject everything else.
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}

interface XenovaTensor {
  data: Float32Array;
  dims: number[];
  tolist?(): number[][];
}

function tensorToVectors(tensor: XenovaTensor, rowCount: number): number[][] {
  if (typeof tensor.tolist === "function") {
    const list = tensor.tolist();
    if (Array.isArray(list) && list.length === rowCount) return list;
  }
  const total = tensor.data.length;
  if (total === 0 || total % rowCount !== 0) {
    throw new Error(
      `unexpected tensor shape: data.length=${total}, rows=${rowCount}, dims=${tensor.dims.join("x")}`,
    );
  }
  const dim = total / rowCount;
  const out: number[][] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const slice = tensor.data.slice(i * dim, (i + 1) * dim);
    out.push(Array.from(slice));
  }
  return out;
}
