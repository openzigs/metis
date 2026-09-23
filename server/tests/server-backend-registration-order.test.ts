/**
 * #60 — the shared-backend factories must be registered before `createApp()`.
 *
 * Building the routers resolves some of those backends (`documentsRouter` →
 * `getKnowledgeService()` → `getVectorStore()`), and a backend selected by env but not
 * yet registered throws. Registered after `createApp()`, `VECTOR_STORE=pgvector` — the
 * production Helm setting — made the server exit before it listened. The registration
 * block is skipped under `NODE_ENV=test`, so no test that boots the server can see the
 * order; this pins it in the source, and the image smoke's Postgres arm
 * (scripts/lib/smoke-server-image.mjs) proves it on a real boot.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf-8",
);

describe("createServer registers backend factories before building the app (#60)", () => {
  const createApp = source.indexOf("const app = createApp(opts);");

  it.each([
    "registerPgVectorStore",
    "registerPostgresRateLimitStore",
    "registerPostgresSSOStateStore",
    "registerPostgresSamlRequestIdCache",
    "registerS3Storage",
  ])("%s() is called once, before createApp()", (fn) => {
    const calls = [...source.matchAll(new RegExp(`^\\s+${fn}\\(\\);$`, "gm"))];
    expect(createApp).toBeGreaterThan(-1);
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBeLessThan(createApp);
  });
});
