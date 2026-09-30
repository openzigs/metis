/**
 * #552 — the binding-write stamp. The interleavings it closes, and that the
 * stamp leaves `updatedAt` alone, are proven against a real database in
 * `tests/vault-rotate-binding-race-552.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  secret: { findMany: vi.fn(), updateMany: vi.fn() },
  $executeRaw: vi.fn(async () => 1),
}));
vi.mock("../prisma.js", () => ({ prisma: db }));

const {
  BINDING_WRITE_WINDOW_MS,
  SECRET_BINDING_WINDOW_EXPIRED,
  assertBindingWriteWindowOpen,
  bindingWriteInProgress,
  markBindingWrite,
  stampedFor,
} = await import("./binding-write-mark.js");

beforeEach(() => {
  db.secret.findMany.mockReset();
  db.secret.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
  db.secret.updateMany.mockReset();
  db.$executeRaw.mockClear();
});

/** The SQL text and bound values of each raw stamp. */
const stamps = () =>
  db.$executeRaw.mock.calls.map((call) => {
    const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
    return { sql: strings.join("?"), values };
  });

describe("markBindingWrite", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const until = new Date(now.getTime() + BINDING_WRITE_WINDOW_MS);
  const filters = [{ id: "s1" }, { name: { endsWith: ":s1" } }];

  it("stamps each live candidate row the caller owns, re-stating the owner, and returns the window end", async () => {
    expect(await markBindingWrite(filters, "u-1", now)).toEqual(until);
    expect(db.secret.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { deletedAt: null, OR: filters, createdById: "u-1" },
      select: { id: true },
    });
    expect(stamps()).toEqual([
      {
        sql: 'UPDATE "secrets" SET "bindingWriteUntil" = ? WHERE "id" = ? AND "deletedAt" IS NULL AND "createdById" = ?',
        values: [until, "s1", "u-1"],
      },
      {
        sql: 'UPDATE "secrets" SET "bindingWriteUntil" = ? WHERE "id" = ? AND "deletedAt" IS NULL AND "createdById" = ?',
        values: [until, "s2", "u-1"],
      },
    ]);
  });

  it("stamps regardless of owner for a vault.reveal caller", async () => {
    expect(await markBindingWrite(filters, null, now)).toEqual(until);
    expect(db.secret.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { deletedAt: null, OR: filters },
      select: { id: true },
    });
    expect(stamps().map((s) => s.values)).toEqual([
      [until, "s1"],
      [until, "s2"],
    ]);
    expect(stamps()[0].sql).not.toContain("createdById");
  });

  it("never goes through Prisma's update, which would bump `updatedAt`", async () => {
    await markBindingWrite(filters, "u-1", now);
    expect(db.secret.updateMany).not.toHaveBeenCalled();
    for (const { sql } of stamps()) expect(sql).not.toContain("updatedAt");
  });

  it("writes nothing when there is nothing to stamp", async () => {
    expect(await markBindingWrite([], "u-1")).toBeNull();
    expect(db.secret.findMany).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("stampedFor", () => {
  const until = new Date("2026-09-30T12:01:00.000Z");
  it("holds for this write's stamp or a later one, never for none", () => {
    expect(stampedFor(until, until)).toBe(true);
    expect(stampedFor(new Date(until.getTime() + 1), until)).toBe(true);
    expect(stampedFor(new Date(until.getTime() - 1), until)).toBe(false);
    expect(stampedFor(null, until)).toBe(false);
    expect(stampedFor(until, null)).toBe(false);
  });
});

describe("bindingWriteInProgress", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  it("is open strictly before the window end", () => {
    expect(bindingWriteInProgress(null, now)).toBe(false);
    expect(bindingWriteInProgress(new Date(now.getTime() + 1), now)).toBe(true);
    expect(bindingWriteInProgress(now, now)).toBe(false);
    expect(bindingWriteInProgress(new Date(now.getTime() - 1), now)).toBe(false);
  });
});

describe("assertBindingWriteWindowOpen", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  it("lets a write land strictly before its window end, or when nothing was stamped", () => {
    expect(() => assertBindingWriteWindowOpen(null, now)).not.toThrow();
    expect(() => assertBindingWriteWindowOpen(new Date(now.getTime() + 1), now)).not.toThrow();
  });

  it("refuses (409) a write at or after its window end — exactly when a rotation may land", () => {
    for (const until of [now, new Date(now.getTime() - 1)]) {
      expect(bindingWriteInProgress(until, now)).toBe(false);
      expect(() => assertBindingWriteWindowOpen(until, now)).toThrow(
        expect.objectContaining({ statusCode: 409, code: SECRET_BINDING_WINDOW_EXPIRED }),
      );
    }
  });
});
