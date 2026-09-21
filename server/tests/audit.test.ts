/**
 * Audit redaction + queueing tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<Record<string, unknown>> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
  },
}));

import {
  AuditService,
  __resetAuditSingleton,
  audit,
  hashJson,
  redact,
} from "../src/lib/audit/audit-service.js";

beforeEach(() => {
  created.length = 0;
  __resetAuditSingleton();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("audit redact()", () => {
  it("redacts well-known sensitive keys at any depth", () => {
    const out = redact({
      headers: {
        authorization: "Bearer secret",
        cookie: "session=abc",
        accept: "*/*",
      },
      body: { password: "p", nested: { token: "t", safe: "ok" } },
    }) as Record<string, Record<string, unknown>>;
    expect(out.headers.authorization).toBe("[REDACTED]");
    expect(out.headers.cookie).toBe("[REDACTED]");
    expect(out.headers.accept).toBe("*/*");
    expect(out.body.password).toBe("[REDACTED]");
    const nested = out.body.nested as Record<string, unknown>;
    expect(nested.token).toBe("[REDACTED]");
    expect(nested.safe).toBe("ok");
  });

  it("redacts inside arrays", () => {
    const out = redact([{ apiKey: "x" }, { apiKey: "y" }]) as Array<Record<string, string>>;
    expect(out[0].apiKey).toBe("[REDACTED]");
    expect(out[1].apiKey).toBe("[REDACTED]");
  });

  it("returns primitives as-is", () => {
    expect(redact("plain")).toBe("plain");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});

describe("hashJson", () => {
  it("produces a stable sha256 hex digest", () => {
    expect(hashJson({ a: 1 })).toBe(hashJson({ a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
    expect(hashJson({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AuditService", () => {
  it("queues record() and persists hashed args/result without plaintext", async () => {
    const svc = new AuditService();
    svc.record({
      actorId: "user-1",
      action: "user.login",
      targetType: "user",
      targetId: "user-1",
      args: { username: "alice", password: "secret" },
      result: { ok: true },
      metadata: { ip: "1.2.3.4" },
    });
    // queueMicrotask resolves on the next microtask tick
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(created).toHaveLength(1);
    const row = created[0];
    expect(row.actorId).toBe("user-1");
    expect(row.action).toBe("user.login");
    expect(row.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.resultHash).toMatch(/^[0-9a-f]{64}$/);
    const meta = JSON.parse(row.metadata as string) as Record<string, unknown>;
    expect(meta.ip).toBe("1.2.3.4");
    // No plaintext args/result in meta unless deepAudit
    expect(meta.args).toBeUndefined();
    expect(meta.result).toBeUndefined();
    // The hash digest is stable & deterministic — simply asserting that the
    // password value never leaks into the persisted row.
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("includes redacted args/result in metadata when deepAudit=true", async () => {
    const svc = new AuditService();
    await svc.recordAndFlush({
      action: "vault.read",
      targetType: "secret",
      targetId: "sec_1",
      args: { authorization: "Bearer leak", id: "sec_1" },
      deepAudit: true,
    });
    const row = created[0];
    const meta = JSON.parse(row.metadata as string) as { args: Record<string, string> };
    expect(meta.args.authorization).toBe("[REDACTED]");
    expect(meta.args.id).toBe("sec_1");
  });

  it("audit() helper resolves the singleton and queues a write", async () => {
    audit({
      actor: "user-2",
      action: "secret.create",
      target: { type: "secret", id: "sec_x" },
    });
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(created).toHaveLength(1);
    expect(created[0].actorId).toBe("user-2");
  });
});
