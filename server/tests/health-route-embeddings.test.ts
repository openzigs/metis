/**
 * Issue #783 — `/readyz` must tell the truth about the embeddings backend.
 *
 * Three states, three answers:
 *
 *   - loaded, real model      → ok
 *   - hash fallback ACTIVE    → degraded, and it says so in words. It is serving;
 *                               what it serves is noise.
 *   - failed to load          → error → /readyz returns 503, so a rollout that
 *                               broke the embeddings config never goes ready and
 *                               never gets traffic to write bad vectors with.
 *
 * The last one is the entire point of the issue. Before #783 that same broken
 * config produced a green /readyz and a corpus of hash vectors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn(async () => ({ id: "user_admin" })) },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

const snapshot = vi.fn();
vi.mock("../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({ snapshot }),
}));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp();
  snapshot.mockReset();
});

describe("/readyz — embeddings check (#783)", () => {
  it("ok when a real backend is loaded, and names the model + dimension", async () => {
    snapshot.mockReturnValue({
      loaded: true,
      ok: true,
      status: "ok",
      backend: "xenova",
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      fellBack: false,
      hashFallbackAllowed: false,
      error: null,
    });
    const res = await request(app).get("/readyz");
    expect(res.body.checks.embeddings.status).toBe("ok");
    expect(res.body.checks.embeddings.message).toContain("Alibaba-NLP/gte-modernbert-base");
    expect(res.body.checks.embeddings.message).toContain("768");
  });

  it("ERRORS (503) when the backend failed to load — never a silent pass", async () => {
    snapshot.mockReturnValue({
      loaded: false,
      ok: false,
      status: "error",
      backend: "sidecar",
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      fellBack: false,
      hashFallbackAllowed: false,
      error: "connect ECONNREFUSED 10.0.0.5:5050",
    });
    const res = await request(app).get("/readyz");
    expect(res.body.checks.embeddings.status).toBe("error");
    expect(res.body.checks.embeddings.message).toContain("ECONNREFUSED");
    // Overall error → 503. This is what stops the rollout.
    expect(res.body.status).toBe("error");
    expect(res.status).toBe(503);
  });

  it("DEGRADES when an opted-in hash fallback is active, and says the vectors are not semantic", async () => {
    snapshot.mockReturnValue({
      loaded: true,
      ok: false,
      status: "degraded",
      backend: "offline",
      model: "metis-offline-hash-v1",
      dimension: 384,
      fellBack: true,
      hashFallbackAllowed: true,
      error: "HF 401",
    });
    const res = await request(app).get("/readyz");
    expect(res.body.checks.embeddings.status).toBe("degraded");
    expect(res.body.checks.embeddings.message).toMatch(/hash fallback ACTIVE/);
    expect(res.body.checks.embeddings.message).toMatch(/NOT semantic/);
    // Degraded, not error: it IS serving. The operator is told, and the pod stays
    // ready — because they asked for this explicitly.
    expect(res.status).toBe(200);
  });

  it("says 'not warmed yet' rather than claiming a healthy load it has not made", async () => {
    snapshot.mockReturnValue({
      loaded: false,
      ok: true,
      status: "ok",
      backend: "xenova",
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      fellBack: false,
      hashFallbackAllowed: false,
      error: null,
    });
    const res = await request(app).get("/readyz");
    expect(res.body.checks.embeddings.status).toBe("ok");
    expect(res.body.checks.embeddings.message).toMatch(/not warmed yet/);
  });

  it("does not blow up the whole health check when the embedder module throws", async () => {
    snapshot.mockImplementation(() => {
      throw new Error("registry exploded");
    });
    const res = await request(app).get("/readyz");
    expect(res.body.checks.embeddings.status).toBe("error");
    expect(res.body.checks.embeddings.message).toContain("registry exploded");
    // The other checks still ran.
    expect(res.body.checks.database.status).toBe("ok");
  });
});
