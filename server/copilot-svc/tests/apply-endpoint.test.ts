/**
 * Epic #195 / Issue #218 — copilot-svc /apply endpoint tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, __resetClientCache } from "../src/app.js";

const TOKEN = "test-secret-token-apply";
const AUTH = `Bearer ${TOKEN}`;

beforeEach(() => {
  process.env.COPILOT_NATIVE_TOKEN = TOKEN;
  __resetClientCache();
});

afterEach(() => {
  delete process.env.COPILOT_NATIVE_TOKEN;
  delete process.env.MORPH_API_KEY;
  vi.restoreAllMocks();
  __resetClientCache();
});

const successApply = async () => ({
  content: "patched",
  provider: "morph" as const,
  model: "morph-v3",
  usage: { promptTokens: 12, completionTokens: 6, totalTokens: 18 },
  durationMs: 9,
});

describe("POST /apply", () => {
  it("rejects unauthenticated calls", async () => {
    const app = createApp({ morphApply: successApply });
    const res = await request(app).post("/apply").send({ original: "a", patch: "b" });
    expect(res.status).toBe(401);
  });

  it("rejects bad payloads with 400", async () => {
    const app = createApp({ morphApply: successApply });
    const res = await request(app).post("/apply").set("authorization", AUTH).send({ original: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("returns the morph response on success", async () => {
    const app = createApp({ morphApply: successApply });
    const res = await request(app)
      .post("/apply")
      .set("authorization", AUTH)
      .send({ original: "a", patch: "b", path: "f.ts" });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("patched");
    expect(res.body.usage.totalTokens).toBe(18);
  });

  it("returns 503 when MORPH_API_KEY is missing (and no stub provided)", async () => {
    delete process.env.MORPH_API_KEY;
    // Force the default path which checks the env key.
    const app = createApp();
    const res = await request(app)
      .post("/apply")
      .set("authorization", AUTH)
      .send({ original: "a", patch: "b" });
    expect(res.status).toBe(503);
  });

  it("returns 502 when the morph client throws a generic error", async () => {
    const app = createApp({
      morphApply: async () => {
        throw new Error("upstream broke");
      },
    });
    const res = await request(app)
      .post("/apply")
      .set("authorization", AUTH)
      .send({ original: "a", patch: "b" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("morph_apply_failed");
  });

  it("returns 503 when MORPH_API_KEY is configured but missing in env", async () => {
    const app = createApp({
      morphApply: async () => {
        throw new Error("MORPH_API_KEY is not configured");
      },
    });
    const res = await request(app)
      .post("/apply")
      .set("authorization", AUTH)
      .send({ original: "a", patch: "b" });
    expect(res.status).toBe(503);
  });

  it("rejects requests with a 503 when the shared secret is unset", async () => {
    delete process.env.COPILOT_NATIVE_TOKEN;
    const app = createApp({ morphApply: successApply });
    const res = await request(app)
      .post("/apply")
      .set("authorization", AUTH)
      .send({ original: "a", patch: "b" });
    expect(res.status).toBe(503);
  });

  it("validates patch is required", async () => {
    const app = createApp({ morphApply: successApply });
    const res = await request(app)
      .post("/apply")
      .set("authorization", AUTH)
      .send({ original: "a", patch: "" });
    expect(res.status).toBe(400);
  });

  it("forwards path/model through to the morph client", async () => {
    const apply = vi.fn(successApply);
    const app = createApp({ morphApply: apply });
    await request(app)
      .post("/apply")
      .set("authorization", AUTH)
      .send({ original: "a", patch: "b", path: "f.ts", model: "morph-pro" });
    expect(apply).toHaveBeenCalledWith({
      original: "a",
      patch: "b",
      path: "f.ts",
      model: "morph-pro",
    });
  });
});
