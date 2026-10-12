/**
 * #1059 — one way to reach a `spec_kit_jobs` table from a test, whichever store
 * is behind it: the in-memory fake, or the real store on a real database. The
 * suites written against it (`spec-kit-job-store-contract.ts`,
 * `spec-kit-job-rules.ts`) therefore assert the same things about both.
 */
import type { PrismaClient } from "@prisma/client";
import type { SpecKitJobRow } from "../../src/lib/spec-kit/job-store.js";
import {
  fakeSpecKitJobRows,
  fakeSpecKitJobStore,
  plantFakeSpecKitJob,
  resetFakeSpecKitJobStore,
} from "./spec-kit-job-store-fake.js";

export type SpecKitJobStoreApi = typeof fakeSpecKitJobStore;

export interface SpecKitJobTable {
  /** "fake", "sqlite" or "postgres" — for test titles. */
  label: string;
  /**
   * The store under test, as a plain object: `vi.spyOn(table.store, "finishJob")`
   * intercepts the job runner's calls too when this object is the module mock.
   */
  store: SpecKitJobStoreApi;
  /** Insert a row as another process would have left it. */
  plant(row: Partial<SpecKitJobRow> & { id: string }): Promise<SpecKitJobRow>;
  get(id: string): Promise<SpecKitJobRow | null>;
  /** Change a row behind the store's back (age a heartbeat, flip a status). */
  patch(id: string, data: Partial<SpecKitJobRow>): Promise<void>;
  /** Ids of every row of the given projects, sorted. */
  ids(projectIds: readonly string[]): Promise<string[]>;
  /** Delete every row of the given projects. */
  reset(projectIds: readonly string[]): Promise<void>;
}

const DEFAULTS = {
  projectId: "p1",
  command: "speckit.plan",
  featureSlug: null,
  activeKey: null,
  status: "running",
  phase: null,
  result: null,
  error: null,
  startedById: null,
  finishedAt: null,
};

export function fakeSpecKitJobTable(): SpecKitJobTable {
  return {
    label: "fake",
    store: fakeSpecKitJobStore,
    plant: async (row) => ({ ...plantFakeSpecKitJob(row) }),
    get: async (id) => {
      const row = fakeSpecKitJobRows.get(id);
      return row ? { ...row } : null;
    },
    patch: async (id, data) => {
      const row = fakeSpecKitJobRows.get(id);
      if (row) Object.assign(row, data);
    },
    ids: async (projectIds) =>
      [...fakeSpecKitJobRows.values()]
        .filter((row) => projectIds.includes(row.projectId))
        .map((row) => row.id)
        .sort(),
    // The fake holds nothing else: clearing it all is the same thing.
    reset: async () => resetFakeSpecKitJobStore(),
  };
}

/** The REAL store (`src/lib/spec-kit/job-store.ts`) over a real database. */
export function prismaSpecKitJobTable(
  label: string,
  db: () => PrismaClient,
  store: SpecKitJobStoreApi,
): SpecKitJobTable {
  return {
    label,
    store,
    plant: async (row) => {
      const now = new Date();
      return db().specKitJob.create({
        data: { ...DEFAULTS, heartbeatAt: now, startedAt: now, ...row },
      });
    },
    get: (id) => db().specKitJob.findUnique({ where: { id } }),
    patch: async (id, data) => {
      await db().specKitJob.updateMany({ where: { id }, data });
    },
    ids: async (projectIds) =>
      (
        await db().specKitJob.findMany({
          where: { projectId: { in: [...projectIds] } },
          select: { id: true },
        })
      )
        .map((row) => row.id)
        .sort(),
    reset: async (projectIds) => {
      await db().specKitJob.deleteMany({ where: { projectId: { in: [...projectIds] } } });
    },
  };
}
