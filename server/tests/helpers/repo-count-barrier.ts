/**
 * Shared by the #457/#463 repository-primary suites (SQLite and Postgres).
 */
import type { PrismaClient } from "@prisma/client";

/** Proxy `db` so that reading `repoConnection` yields `repo`. */
function withRepo(db: PrismaClient, repo: PrismaClient["repoConnection"]): PrismaClient {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "repoConnection") return repo;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A client whose `repoConnection` methods named in `overrides` are replaced,
 * and every other method is the real one bound to the real delegate.
 */
export function overrideRepoConnection(
  db: PrismaClient,
  overrides: Partial<Record<keyof PrismaClient["repoConnection"], unknown>>,
): PrismaClient {
  const repo = db.repoConnection;
  const wrapped = new Proxy(repo, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return overrides[prop as keyof typeof overrides];
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return withRepo(db, wrapped);
}

/**
 * A client whose `repoConnection.count` holds every caller until `n` callers
 * have counted — so `n` concurrent creates all read the same (empty) project
 * before any of them inserts. The race, made deterministic.
 */
export function countBarrier(db: PrismaClient, n: number): PrismaClient {
  let arrived = 0;
  let release!: () => void;
  const allCounted = new Promise<void>((r) => (release = r));
  const repo = db.repoConnection;
  return overrideRepoConnection(db, {
    count: async (args: Parameters<typeof repo.count>[0]) => {
      const result = await repo.count(args);
      arrived += 1;
      if (arrived === n) release();
      await allCounted;
      return result;
    },
  });
}
