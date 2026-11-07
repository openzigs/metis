/**
 * #1893 — concurrent borrows of a similar requirement's code links on a REAL
 * database, shared by the SQLite test (`borrow-citations-race-1893.sqlite.test.ts`)
 * and its Postgres twin (`borrow-citations-race-1893-postgres.integration.test.ts`).
 *
 * `borrowCitations` reads the code the requirement already holds, then
 * `createMany`s the rest; the table has no unique key that could catch a
 * repeat (two writers legitimately link one file twice, #1825). Two borrows at
 * once both read "holds nothing" and both copied every link. The read and the
 * write are now one serializable transaction: Postgres aborts one racer with a
 * serialization failure and the retry sees the winner's rows; SQLite runs one
 * write transaction at a time.
 *
 * The interleaving is FORCED, not raced. The suite hands the code a client
 * whose `requirementCodeMapping` delegate (on the client AND on the
 * transaction client `$transaction` passes in) lets each racer's first call
 * run and then holds it until every racer's first call has returned, so every
 * racer has read the origin's links before any racer reads what the target
 * holds. A barrier that never fills opens after a fallback, so an engine that
 * serialises the transactions (SQLite) is not deadlocked: `forced` says
 * whether the suite must see every racer arrive. Every outcome is read back
 * from the rows.
 *
 * The calling file must `vi.mock` `lib/prisma.js` so `prisma` returns
 * `state.db`, before importing this module.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { borrowCitations } from "../../src/lib/traceability/borrow-citations.js";

export interface BorrowRaceState {
  db: unknown;
}

interface Barrier {
  size: number;
  remaining: number;
  arrived: number;
  /** How many racers had arrived when the barrier opened; `null` while closed. */
  arrivedAtOpen: number | null;
  open: Promise<void>;
  release: () => void;
}

function newBarrier(size: number): Barrier {
  let resolve!: () => void;
  const open = new Promise<void>((r) => (resolve = r));
  const barrier: Barrier = {
    size,
    remaining: size,
    arrived: 0,
    arrivedAtOpen: null,
    open,
    release: () => {
      barrier.arrivedAtOpen ??= barrier.arrived;
      resolve();
    },
  };
  return barrier;
}

/** `client` with its `requirementCodeMapping` calls held at `barrier` (see the file header). */
function gated<T extends object>(client: T, barrier: Barrier, fallbackMs: number): T {
  const delegate = (client as { requirementCodeMapping: object }).requirementCodeMapping;
  const wrapped = new Proxy(delegate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const held = barrier.remaining > 0;
        if (held) barrier.remaining -= 1;
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (held) {
          barrier.arrived += 1;
          if (barrier.arrived === barrier.size) barrier.release();
          const timer = setTimeout(barrier.release, fallbackMs);
          await barrier.open;
          clearTimeout(timer);
        }
        return result;
      };
    },
  });
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "requirementCodeMapping") return wrapped;
      if (prop === "$transaction") {
        return (fn: (tx: object) => Promise<unknown>, opts?: unknown) =>
          (target as unknown as PrismaClient).$transaction(
            (tx) => fn(gated(tx, barrier, fallbackMs)),
            opts as never,
          );
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

export function describeBorrowCitationsRace(opts: {
  title: string;
  skip: boolean;
  state: BorrowRaceState;
  open: () => Promise<PrismaClient>;
  close: () => Promise<void>;
  /** Unique per run, so a shared Postgres database never collides. */
  suffix: string;
  /** The engine runs the racers' transactions at once, so every racer must reach the barrier. */
  forced: boolean;
  hookTimeoutMs?: number;
}): void {
  const { state, suffix } = opts;
  const USER = `u-1893race-${suffix}`;
  const PROJECT = `p-1893race-${suffix}`;
  const ANALYSIS = `an-1893race-${suffix}`;
  const ORIGIN = `r-1893race-origin-${suffix}`;
  const FILES = ["src/a.ts", "src/b.ts"];
  const RACERS = 2;

  describe.skipIf(opts.skip)(opts.title, () => {
    let db: PrismaClient;
    let seq = 0;

    async function requirement(): Promise<string> {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `r-1893race-${suffix}-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: "t",
          body: "b",
        },
      });
      return row.id;
    }

    beforeAll(async () => {
      db = await opts.open();
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: USER },
      });
      await db.requirement.create({
        data: {
          id: ORIGIN,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: "origin",
          body: "origin",
        },
      });
      for (const filePath of FILES) {
        await db.requirementCodeMapping.create({
          data: {
            requirementId: ORIGIN,
            projectId: PROJECT,
            filePath,
            source: "analysis-grounding",
            freshness: "fresh",
          },
        });
      }
    }, opts.hookTimeoutMs);

    afterAll(async () => {
      if (db) {
        await db.requirementCodeMapping.deleteMany({ where: { projectId: PROJECT } });
        await db.requirement.deleteMany({ where: { projectId: PROJECT } });
        await db.analysis.deleteMany({ where: { projectId: PROJECT } });
        await db.project.deleteMany({ where: { id: PROJECT } });
        await db.user.deleteMany({ where: { id: USER } });
      }
      await opts.close();
    }, opts.hookTimeoutMs);

    it("borrows forced to run at once copy each link exactly once", async () => {
      const target = await requirement();
      const barrier = newBarrier(RACERS);
      const client = gated(db, barrier, 1_000);
      const results = await Promise.all(
        Array.from({ length: RACERS }, () =>
          borrowCitations(PROJECT, target, { fromRequirementId: ORIGIN }, { prisma: client }),
        ),
      );
      if (opts.forced) expect(barrier.arrivedAtOpen).toBe(RACERS);

      const rows = await db.requirementCodeMapping.findMany({
        where: { requirementId: target, projectId: PROJECT },
        select: { filePath: true, source: true },
      });
      expect(rows.map((r) => r.filePath).sort()).toEqual(FILES);
      expect(rows.every((r) => r.source === "similar-requirement")).toBe(true);
      expect(results.reduce((n, r) => n + r.copied, 0)).toBe(FILES.length);
      expect(results.reduce((n, r) => n + r.skippedDuplicate, 0)).toBe(FILES.length * (RACERS - 1));
    });
  });
}
