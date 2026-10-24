/**
 * #1458 — body-parser GHSA-27r3-jxmh-p828, through the real `createApp()`: a compressed
 * request body is refused with 415 on a JSON route, on the HMAC-signed webhook routes
 * and on the role-reconciliation parser, and never reaches a handler. Uncompressed
 * bodies still work, and webhook signature verification still sees the raw bytes.
 *
 * Prisma is mocked the way `app.test.ts` mocks it; nothing here needs a database.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// #1484 — this suite's prisma double has no `webhookPayloadDigest`; the replay
// claim fails closed (503) without one, so stub it as "first time seen".
vi.mock("../src/lib/webhooks/payload-replay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/webhooks/payload-replay.js")>()),
  claimPayload: vi.fn(async () => ({ duplicate: false })),
  releasePayload: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const users = new Map<
    string,
    { id: string; username: string; displayName: string; email: string }
  >();
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { username: string };
          create: { username: string; displayName: string; email: string };
        }) => {
          const row = users.get(where.username) ?? { id: `user_${users.size + 1}`, ...create };
          users.set(where.username, row);
          return row;
        },
      ),
      findUnique: vi.fn(async () => null),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    revokedRefreshToken: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    userSessionRevocation: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    trigger: { findMany: vi.fn(async () => []) },
  });
  return { prisma };
});

import request from "supertest";
import { createApp } from "../src/app.js";

const SECRET = "test-webhook-secret-1458";
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
});

/** superagent JSON-serialises a Buffer sent as `application/json`; send the bytes verbatim. */
const raw = (body: unknown) => body as string;
const sign = (body: string | Buffer) =>
  `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("createApp() refuses compressed request bodies (#1458)", () => {
  const app = createApp();
  const LOGIN = JSON.stringify({ username: "admin", password: "password" });

  it("a gzip JSON body to /api/auth/login is a 415, and the same body uncompressed logs in", async () => {
    const refused = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize(raw)
      .send(zlib.gzipSync(LOGIN));
    expect(refused.status).toBe(415);
    expect(refused.body.error.code).toBe("UNSUPPORTED_CONTENT_ENCODING");

    const plain = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send(LOGIN);
    expect(plain.status).toBe(200);
    expect(plain.body.data.accessToken).toBeTypeOf("string");
  });

  it("a gzip form body is a 415 too (the global urlencoded parser)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .set("Content-Encoding", "gzip")
      .serialize(raw)
      .send(zlib.gzipSync("username=admin&password=password"));
    expect(res.status).toBe(415);
  });

  it("a gzip body to the role-reconciliation parser is a 415, ahead of auth", async () => {
    const res = await request(app)
      .post("/api/admin/auth/role-reconciliation/inspect")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize(raw)
      .send(zlib.gzipSync("{}"));
    expect(res.status).toBe(415);
  });

  describe("GitHub PR webhook (/api/webhooks/github/pr)", () => {
    // Deliberate whitespace: a signature over these exact bytes verifies only if the
    // route sees the raw body, not a re-serialised `req.body`.
    const PAYLOAD = '{ "zen":  "Keep it logically awesome." ,"hook_id": 1 }';

    it("refuses a gzip delivery with 415 even when the signature over its bytes is valid", async () => {
      const gz = zlib.gzipSync(PAYLOAD);
      const res = await request(app)
        .post("/api/webhooks/github/pr")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", "gzip")
        .set("X-Hub-Signature-256", sign(gz))
        .serialize(raw)
        .send(gz);
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe("UNSUPPORTED_CONTENT_ENCODING");
    });

    it("accepts an uncompressed delivery signed over its raw bytes", async () => {
      const res = await request(app)
        .post("/api/webhooks/github/pr")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", sign(PAYLOAD))
        .send(PAYLOAD);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(415);
      expect(res.status).toBeLessThan(300);
    });

    it("still rejects an uncompressed delivery whose signature does not match", async () => {
      const res = await request(app)
        .post("/api/webhooks/github/pr")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", sign(`${PAYLOAD} `))
        .send(PAYLOAD);
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe("BAD_SIGNATURE");
    });
  });

  it("a gzip delivery to the trigger webhook (/api/webhooks/github) is a 415", async () => {
    const gz = zlib.gzipSync('{"repository":{"full_name":"o/r"}}');
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .set("X-Hub-Signature-256", sign(gz))
      .serialize(raw)
      .send(gz);
    expect(res.status).toBe(415);
  });
});
