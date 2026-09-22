/**
 * Epic #728 / Issue #733 — Optimistic-locking middleware tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response } from "express";
import request from "supertest";
import { optimisticLock } from "../src/middleware/optimistic-lock.js";

function createApp(fetcher: Parameters<typeof optimisticLock>[1]) {
  const app = express();
  app.use(express.json());

  app.put("/items/:id", optimisticLock("item", fetcher), (_req: Request, res: Response) => {
    res.json({ success: true, nextVersion: res.locals.nextVersion });
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { statusCode?: number; status?: number; code?: string; message?: string };
      res.status(e.statusCode ?? e.status ?? 500).json({
        error: { code: e.code ?? "INTERNAL", message: e.message ?? "?" },
      });
    },
  );

  return app;
}

describe("optimisticLock middleware", () => {
  const fetcher = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it("passes through when no version in body (backwards compat)", async () => {
    const app = createApp(fetcher);
    const res = await request(app).put("/items/1").send({ title: "test" });
    expect(res.status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes through and sets nextVersion when versions match", async () => {
    fetcher.mockResolvedValue({ id: "1", version: 3, title: "Server title" });
    const app = createApp(fetcher);
    const res = await request(app).put("/items/1").send({ version: 3, title: "Updated" });
    expect(res.status).toBe(200);
    expect(res.body.nextVersion).toBe(4);
  });

  it("returns 409 on version conflict with diff payload", async () => {
    fetcher.mockResolvedValue({ id: "1", version: 5, title: "Server title" });
    const app = createApp(fetcher);
    const res = await request(app).put("/items/1").send({ version: 3, title: "My outdated title" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
    expect(res.body.error.conflict).toBe(true);
    // Field-level diff only — no full record or full request body leak.
    expect(res.body.error.serverVersion).toBe(5);
    expect(res.body.error.clientVersion).toBe(3);
    expect(res.body.error.diff).toEqual([
      { field: "title", server: "Server title", client: "My outdated title" },
    ]);
    // Full records must NOT be present.
    expect(res.body.error.serverRecord).toBeUndefined();
    expect(res.body.error.clientBody).toBeUndefined();
  });

  // A field whose value is an array (a requirement's `labels`) is never `===`
  // an equivalent array from the request body, so identity comparison reported
  // it as conflicting on every 409 — and the merge modal then offered to keep a
  // "server version" identical to what the client already sent.
  it("does not report an array field as conflicting when the values are equal", async () => {
    fetcher.mockResolvedValue({
      id: "1",
      version: 5,
      title: "Server title",
      labels: ["a", "b"],
    });
    const app = createApp(fetcher);
    const res = await request(app)
      .put("/items/1")
      .send({ version: 2, title: "Client title", labels: ["a", "b"] });

    expect(res.status).toBe(409);
    const fields = (res.body.error.diff as Array<{ field: string }>).map((d) => d.field);
    expect(fields).toContain("title");
    expect(fields).not.toContain("labels");
  });

  it("still reports an array field whose contents genuinely differ", async () => {
    fetcher.mockResolvedValue({ id: "1", version: 5, labels: ["a"] });
    const app = createApp(fetcher);
    const res = await request(app)
      .put("/items/1")
      .send({ version: 2, labels: ["a", "b"] });

    expect(res.status).toBe(409);
    const labelDiff = (res.body.error.diff as Array<{ field: string; server: unknown }>).find(
      (d) => d.field === "labels",
    );
    expect(labelDiff).toBeDefined();
    expect(labelDiff!.server).toEqual(["a"]);
  });

  it("returns 404 when record not found", async () => {
    fetcher.mockResolvedValue(null);
    const app = createApp(fetcher);
    const res = await request(app).put("/items/999").send({ version: 0 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ITEM_NOT_FOUND");
  });

  it("returns 400 for non-numeric version", async () => {
    const app = createApp(fetcher);
    const res = await request(app).put("/items/1").send({ version: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
