/**
 * #35 — through the REAL app (`createApp`, its real 10 MB `express.json()` and
 * its real error handler), an over-limit body is a 413 with a stable code, not
 * a 500. The parser rejects the body before auth or the handler run, so no
 * database is needed.
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

describe("body-parser client errors through createApp (#35)", () => {
  it("PUT /api/requirements/:id with a body over the 10 MB limit → 413 PAYLOAD_TOO_LARGE", async () => {
    const oversized = JSON.stringify({ description: "x".repeat(10 * 1024 * 1024 + 1) });
    const res = await request(createApp())
      .put("/api/requirements/req_1")
      .set("Content-Type", "application/json")
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("an unsupported Content-Encoding → 415 UNSUPPORTED_CONTENT_ENCODING", async () => {
    const res = await request(createApp())
      .post("/api/requirements/req_1/comments")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "x-made-up")
      .send('{"body":"hi"}');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_CONTENT_ENCODING");
  });
});
