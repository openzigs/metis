/**
 * Issue #782 — the pooling/dtype rules are DUPLICATED in two packages:
 *
 *   - `server/embeddings-svc/src/model-config.ts`  (sidecar — must stay
 *     standalone; `Dockerfile.embeddings` builds only this package)
 *   - `server/src/lib/rag/embed-model-config.ts`   (server)
 *
 * Duplication is a deliberate trade (no cross-package import into the sidecar
 * image) but SILENT DRIFT between the two would mean the server sends `mean` for
 * a model the sidecar would have CLS-pooled — exactly the class of bug this
 * issue exists to eliminate. So the copies are compared here, byte for byte,
 * below their (intentionally different) header comments.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SIDECAR_FILE = resolve(here, "../src/model-config.ts");
const SERVER_FILE = resolve(here, "../../src/lib/rag/embed-model-config.ts");

/** Everything from the first exported declaration onwards — the header differs by design. */
function body(path: string): string {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("export type EmbedPooling");
  expect(start, `no "export type EmbedPooling" marker in ${path}`).toBeGreaterThan(-1);
  return source.slice(start);
}

describe("model-config parity (sidecar ↔ server)", () => {
  it("the two copies are byte-identical below the header", () => {
    expect(body(SIDECAR_FILE)).toBe(body(SERVER_FILE));
  });

  it("both copies resolve the same pooling for the models that matter", async () => {
    const sidecar = await import("../src/model-config.js");
    const server = await import("../../src/lib/rag/embed-model-config.js");

    const models = [
      "Xenova/bge-small-en-v1.5",
      "Alibaba-NLP/gte-modernbert-base",
      "onnx-community/granite-embedding-small-english-r2-ONNX",
      "jinaai/jina-embeddings-v2-base-code",
      "Xenova/all-MiniLM-L6-v2",
      "acme/unknown",
    ];
    for (const model of models) {
      expect(server.resolvePooling(model, undefined, {})).toEqual(
        sidecar.resolvePooling(model, undefined, {}),
      );
    }
    expect(server.DEFAULT_DTYPE).toBe(sidecar.DEFAULT_DTYPE);
    expect(server.DEFAULT_POOLING).toBe(sidecar.DEFAULT_POOLING);
  });
});
