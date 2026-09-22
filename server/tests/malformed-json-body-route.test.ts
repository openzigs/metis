/**
 * #21 — through the REAL app (`createApp`, its real `express.json()` and its
 * real error handler), a malformed JSON body is a 400 with a stable code, not
 * a 500. The requirement-update route is the one #14's double-encoded bodies
 * were hitting; the parser rejects the body before auth or the handler run.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import request from "supertest";
import { createApp } from "../src/app.js";

describe("malformed JSON request body through createApp (#21)", () => {
  it("PUT /api/requirements/:id with a double-encoded body → 400 INVALID_JSON", async () => {
    const res = await request(createApp())
      .put("/api/requirements/req_1")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(JSON.stringify({ reviewStatus: "approved", version: 1 })));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: { code: "INVALID_JSON" } });
  });

  it("POST with a truncated body → 400 INVALID_JSON", async () => {
    const res = await request(createApp())
      .post("/api/requirements/req_1/comments")
      .set("Content-Type", "application/json")
      .send('{"body":"hi"');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});
