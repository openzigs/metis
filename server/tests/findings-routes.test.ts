/**
 * Epic #298 / Issue #312 — finding review-ack endpoint tests.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MockFinding {
  id: string;
  derivation: string;
  confidence: number;
  agentResultId: string;
}

const findings = new Map<string, MockFinding>();
const auditCalls: Array<{ action: string; targetId: string; metadata?: Record<string, unknown> }> =
  [];

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return {
    prisma: withRouteAuth({
      $queryRawUnsafe: vi.fn(async () => 1),
      workspaceMember: { findMany: vi.fn(async () => []) },
      user: {
        upsert: vi.fn(async ({ create }: any) => ({ id: `user_${create.username}`, ...create })),
      },
      userRole: {},
      auditLog: { create: vi.fn(async () => ({})) },
      finding: {
        findUnique: vi.fn(async ({ where }: any) => findings.get(where.id) ?? null),
      },
    }),
  };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(
    (entry: { action: string; target: { id: string }; metadata?: Record<string, unknown> }) => {
      auditCalls.push({
        action: entry.action,
        targetId: entry.target.id,
        metadata: entry.metadata,
      });
    },
  ),
}));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let adminToken: string;
let readerToken: string;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
});

beforeEach(async () => {
  findings.clear();
  auditCalls.length = 0;
  app = createApp();
  adminToken = await login("admin");
  readerToken = await login("reader");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/findings/:id/review-ack", () => {
  it("404s when finding does not exist", async () => {
    const res = await request(app)
      .post("/api/findings/nope/review-ack")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("FINDING_NOT_FOUND");
  });

  it("records an audit row and returns the finding id", async () => {
    findings.set("f_1", {
      id: "f_1",
      derivation: "ambiguous",
      confidence: 0.42,
      agentResultId: "ar_1",
    });
    const res = await request(app)
      .post("/api/findings/f_1/review-ack")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ note: "Reviewed during PR walkthrough" });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("f_1");
    expect(res.body.data.reviewedAt).toBeTruthy();
    const ackCalls = auditCalls.filter((c) => c.action === "finding.review-ack");
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0].targetId).toBe("f_1");
    expect(ackCalls[0].metadata?.note).toBe("Reviewed during PR walkthrough");
    expect(ackCalls[0].metadata?.derivation).toBe("ambiguous");
  });

  it("works for reader role (project.read scope)", async () => {
    findings.set("f_1", {
      id: "f_1",
      derivation: "ambiguous",
      confidence: 0.42,
      agentResultId: "ar_1",
    });
    const res = await request(app)
      .post("/api/findings/f_1/review-ack")
      .set("Authorization", `Bearer ${readerToken}`)
      .send({});
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated callers", async () => {
    const res = await request(app).post("/api/findings/f_1/review-ack").send({});
    expect(res.status).toBe(401);
  });

  it("rejects oversized notes with 400 VALIDATION_ERROR", async () => {
    findings.set("f_1", {
      id: "f_1",
      derivation: "ambiguous",
      confidence: 0.42,
      agentResultId: "ar_1",
    });
    const res = await request(app)
      .post("/api/findings/f_1/review-ack")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ note: "x".repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts an empty body", async () => {
    findings.set("f_1", {
      id: "f_1",
      derivation: "ambiguous",
      confidence: 0.42,
      agentResultId: "ar_1",
    });
    const res = await request(app)
      .post("/api/findings/f_1/review-ack")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    const ackCalls = auditCalls.filter((c) => c.action === "finding.review-ack");
    expect(ackCalls[0].metadata?.note).toBe(null);
  });
});
