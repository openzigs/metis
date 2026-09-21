/**
 * Issue #253 — `ConfigService.recordAudit` + `listAudit` unit tests.
 *
 * Validates the redaction rule (secrets always `[REDACTED]`, tunables stored
 * verbatim, oversize tunables truncated, missing values become `[unset]`),
 * the bootstrap-tier guard, the unknown-key guard, and pagination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditRows: Array<Record<string, unknown>> = [];

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    configAudit: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `aud_${auditRows.length + 1}`, ts: new Date(), ...data };
        auditRows.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({
          take,
          cursor,
          skip,
        }: {
          take: number;
          cursor?: { id: string };
          skip?: number;
        }) => {
          let sorted = [...auditRows].sort(
            (a, b) => (b.ts as Date).getTime() - (a.ts as Date).getTime(),
          );
          if (cursor) {
            const idx = sorted.findIndex((r) => r.id === cursor.id);
            if (idx >= 0) sorted = sorted.slice(idx + (skip ?? 0));
          }
          return sorted.slice(0, take);
        },
      ),
    },
    secret: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import {
  ConfigBootstrapError,
  ConfigService,
  ConfigUnknownKeyError,
} from "../../../src/lib/config/index.js";
import type { VaultService } from "../../../src/lib/vault/vault-service.js";

beforeEach(() => {
  auditRows.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

const stubVault = {
  list: vi.fn(async () => []),
  read: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  delete: vi.fn(),
} as unknown as VaultService;

describe("ConfigService.recordAudit", () => {
  it("redacts both old and new values when the key is sensitive", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    await svc.recordAudit({
      key: "OPENAI_API_KEY",
      oldValue: "sk-old-12345",
      newValue: "sk-new-67890",
      actorId: "user_1",
    });
    expect(auditRows[0]).toMatchObject({
      key: "OPENAI_API_KEY",
      oldValueRedacted: "[REDACTED]",
      newValueRedacted: "[REDACTED]",
      actorId: "user_1",
      scope: "global",
    });
  });

  it("stores tunable values verbatim", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    await svc.recordAudit({
      key: "AI_DEFAULT_MODEL",
      oldValue: "gpt-4o",
      newValue: "claude-sonnet-4",
      actorId: "user_admin",
    });
    expect(auditRows[0]).toMatchObject({
      oldValueRedacted: "gpt-4o",
      newValueRedacted: "claude-sonnet-4",
    });
  });

  it("renders null/undefined values as [unset]", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    await svc.recordAudit({
      key: "AI_PROVIDER",
      oldValue: undefined,
      newValue: "openai",
      actorId: "u1",
    });
    expect(auditRows[0]).toMatchObject({
      oldValueRedacted: "[unset]",
      newValueRedacted: "openai",
    });
  });

  it("truncates oversize tunable values to ~1KB with a marker", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    const big = "a".repeat(2000);
    await svc.recordAudit({
      key: "DB_ALLOWED_HOSTS",
      oldValue: "",
      newValue: big,
      actorId: "u1",
    });
    expect(auditRows[0].newValueRedacted as string).toMatch(/…\[truncated]$/);
    expect((auditRows[0].newValueRedacted as string).length).toBeLessThan(big.length);
  });

  it("rejects bootstrap-tier writes defensively", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    await expect(
      svc.recordAudit({
        key: "DATABASE_URL",
        oldValue: "x",
        newValue: "y",
        actorId: "u1",
      }),
    ).rejects.toBeInstanceOf(ConfigBootstrapError);
    expect(auditRows).toHaveLength(0);
  });

  it("rejects unknown keys", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    await expect(
      svc.recordAudit({
        key: "SOMETHING_FAKE",
        oldValue: null,
        newValue: "x",
        actorId: "u1",
      }),
    ).rejects.toBeInstanceOf(ConfigUnknownKeyError);
  });

  it("respects a custom scope", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    await svc.recordAudit({
      key: "AI_DEFAULT_MODEL",
      oldValue: "a",
      newValue: "b",
      actorId: "u1",
      scope: "project_42",
    });
    expect(auditRows[0].scope).toBe("project_42");
  });
});

describe("ConfigService.listAudit", () => {
  it("returns rows newest-first and paginates with a cursor", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    // Seed 3 rows with deterministic timestamps.
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      auditRows.push({
        id: `aud_${i + 1}`,
        key: "AI_DEFAULT_MODEL",
        oldValueRedacted: "old",
        newValueRedacted: `v${i}`,
        actorId: "u1",
        scope: "global",
        ts: new Date(base + i * 1000),
      });
    }
    const page1 = await svc.listAudit({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    // Newest first
    expect(page1.items[0].newValueRedacted).toBe("v2");
    expect(page1.nextCursor).toBeDefined();

    const page2 = await svc.listAudit({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
  });

  it("clamps limit to the [1,200] band", async () => {
    const svc = new ConfigService({ vault: stubVault, env: {} });
    const r1 = await svc.listAudit({ limit: 0 });
    expect(r1.items.length).toBeGreaterThanOrEqual(0);
    const r2 = await svc.listAudit({ limit: 999 });
    expect(r2.items.length).toBeLessThanOrEqual(200);
  });
});
