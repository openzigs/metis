# @metis/embeddings-svc

Sidecar HTTP service that owns the heavy `@huggingface/transformers` +
`onnxruntime-node` runtime so the main `metis-server` image can stay
under the 250 MB budget set by epic [#93](https://github.com/openzigs/metis-private/issues/93).

## Endpoints

| Method | Path        | Purpose                                                |
|--------|-------------|--------------------------------------------------------|
| GET    | `/healthz`  | Liveness probe (no auth)                               |
| POST   | `/embed`    | Compute dense embeddings for a batch of texts          |
| POST   | `/rerank`   | Score (query, candidate) pairs with a cross-encoder    |

All authenticated routes require `Authorization: Bearer ${EMBEDDINGS_TOKEN}`.
The service **fails closed** when `EMBEDDINGS_TOKEN` is unset — `/embed` and
`/rerank` will return `503 service_unavailable`.

## Environment

| Variable                | Default                           | Purpose                                       |
|-------------------------|-----------------------------------|-----------------------------------------------|
| `EMBEDDINGS_PORT`       | `5050`                            | TCP port to listen on                         |
| `EMBEDDINGS_HOST`       | `0.0.0.0`                         | Bind address                                  |
| `EMBEDDINGS_TOKEN`      | _(unset → fail-closed)_           | Shared secret with `metis-server`             |
| `EMBEDDINGS_CACHE_DIR`  | _(transformers default)_          | Override the on-disk model cache directory    |

## Running locally

```bash
# Install deps once at the workspace root
pnpm install --frozen-lockfile

# Build
pnpm --filter @metis/embeddings-svc build

# Start
EMBEDDINGS_TOKEN=dev-only-token \
EMBEDDINGS_PORT=5050 \
node server/embeddings-svc/dist/index.js
```

## Image size policy

This image is **exempt** from the ≤250 MB budget enforced by
`scripts/verify-image-size.sh` — the whole point of the sidecar is to
isolate the multi-hundred-MB ONNX/transformers tree from `metis-server`.
