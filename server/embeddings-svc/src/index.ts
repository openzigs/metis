/**
 * Embeddings sidecar — `metis-embeddings`.
 *
 * A minimal HTTP service that owns the heavy `@huggingface/transformers` +
 * `onnxruntime-node` runtime so the main `metis-server` image can stay
 * under the 250 MB budget set by epic #93.
 *
 * Endpoints:
 *   POST /embed   { texts: string[],   model?: string } → { vectors, model, dimension }
 *   POST /rerank  { query, candidates, model? }         → { scores: number[] }
 *   GET  /healthz                                       → { status: "ok", ... }   (liveness)
 *   GET  /readyz                                        → 200 warm / 503 warming  (readiness)
 *
 * Auth:
 *   - All routes except `/healthz` and `/readyz` require
 *     `Authorization: Bearer <EMBEDDINGS_TOKEN>`
 *   - Token comparison is constant-time
 *   - Service refuses to start (or fails closed) if `EMBEDDINGS_TOKEN` is unset
 *     in production.
 */
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { beginWarmup } from "./readiness.js";

const PORT = Number(process.env.EMBEDDINGS_PORT ?? 5050);
const HOST = process.env.EMBEDDINGS_HOST ?? "0.0.0.0";

const app = createApp();
const server = createServer(app);

/**
 * Issue #786 — warm the ONNX session at BOOT, concurrently with `listen`.
 *
 * Order matters, in both directions:
 *
 *   - the warm-up is NOT awaited before `listen`. If it were, `/healthz` would
 *     not answer during the load either, so kubelet's startupProbe would be
 *     probing a closed port and could not distinguish "still loading the model"
 *     from "the process is dead". Binding first means liveness has something
 *     truthful to answer with from the first second.
 *
 *   - it is not deferred to the first request either. That is the pre-#786
 *     behaviour: readiness passed instantly, the pod joined the Service, and the
 *     cold start was paid by the first real ingest.
 *
 * `beginWarmup()` never rejects; the failure lands in `/readyz` (503) instead of
 * killing the process. See `readiness.ts` for why a crash-loop would be worse.
 */
void beginWarmup();

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[embeddings-svc] listening on http://${HOST}:${PORT} — warming model, /readyz returns 503 until it is loaded`,
  );
});

const shutdown = (signal: string): void => {
  // eslint-disable-next-line no-console
  console.log(`[embeddings-svc] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
