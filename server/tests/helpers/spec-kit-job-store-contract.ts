/**
 * #1059 — what a `spec_kit_jobs` store must do, stated once and run against
 * every implementation: the in-memory fake, the real store on SQLite and the
 * real store on Postgres. It is the store's compare-and-set predicates, one by
 * one — who may refresh a row, who may begin saving, who may finish it, what a
 * sweep may touch — and the races between them, each of which must have exactly
 * one winner.
 *
 * Nothing here bounds how FAST anything happens. Ages are planted in the row
 * (a heartbeat two minutes old), never waited for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecKitJobTable } from "./spec-kit-job-table.js";

const STALE_MS = 90_000;
const OUTCOMES = {
  interruptedError: JSON.stringify({ status: 503, code: "INTERRUPTED", message: "none saved" }),
  interruptedWhileSavingError: JSON.stringify({
    status: 503,
    code: "INTERRUPTED",
    message: "may be part-saved",
  }),
};

/** The wall clock, read where a faked `Date` cannot reach it. */
const realNow = (): number => performance.timeOrigin + performance.now();
const ago = (ms: number): Date => new Date(realNow() - ms);

/**
 * @param table  the store under test
 * @param ns     a prefix unique to this run, so a shared database stays clean
 */
export function defineSpecKitJobStoreContract(table: () => SpecKitJobTable, ns: string): void {
  const PA = `${ns}-pa`;
  const PB = `${ns}-pb`;
  const PROJECTS = [PA, PB];
  const id = (name: string): string => `${ns}-${name}`;
  const key = (name: string): string => `${PA}:${name}`;
  let n = 0;
  const fresh = (name: string, over: Record<string, unknown> = {}) => ({
    id: id(name),
    projectId: PA,
    command: "speckit.plan",
    featureSlug: name,
    activeKey: key(name),
    startedById: "u1",
    ...over,
  });
  /** A planted row, live under its own key unless told otherwise. */
  const plant = (name: string, over: Record<string, unknown> = {}) => {
    n += 1;
    const status = (over.status as string | undefined) ?? "running";
    const live = ["running", "cancelling", "saving"].includes(status);
    return table().plant({
      id: id(name),
      projectId: PA,
      featureSlug: name,
      activeKey: live ? key(`${name}-${n}`) : null,
      ...over,
    });
  };
  const store = () => table().store;
  const row = async (name: string) => {
    const found = await table().get(id(name));
    if (!found) throw new Error(`no row ${name}`);
    return found;
  };

  beforeEach(async () => {
    await table().reset(PROJECTS);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await table().reset(PROJECTS);
  });

  describe("createJob — the unique key is what keeps a second writer out", () => {
    it("inserts a running job that holds its key", async () => {
      const created = await store().createJob(fresh("a"));
      expect(created).toMatchObject({
        id: id("a"),
        projectId: PA,
        command: "speckit.plan",
        featureSlug: "a",
        activeKey: key("a"),
        status: "running",
        startedById: "u1",
        phase: null,
        result: null,
        error: null,
        finishedAt: null,
      });
      expect(created?.heartbeatAt).toBeInstanceOf(Date);
      expect(created?.startedAt).toBeInstanceOf(Date);
      expect(await store().findJobByActiveKey(key("a"))).toMatchObject({ id: id("a") });
    });

    it("refuses a second job on the same key with null, and writes no row for it", async () => {
      await store().createJob(fresh("a"));
      expect(await store().createJob(fresh("a", { id: id("a2") }))).toBeNull();
      expect(await table().ids(PROJECTS)).toEqual([id("a")]);
    });

    it("refuses a second job with the same ID, whatever its key, and leaves the first as it was", async () => {
      // The primary key is what makes a start that is sent twice one job.
      await store().createJob(fresh("a"));
      expect(await store().createJob(fresh("elsewhere", { id: id("a") }))).toBeNull();
      expect(await table().ids(PROJECTS)).toEqual([id("a")]);
      expect(await row("a")).toMatchObject({ featureSlug: "a", activeKey: key("a") });
      // …also once that job has finished and released its key.
      expect(await store().finishJob(id("a"), { status: "succeeded" }, ["running"])).toBe(true);
      expect(await store().createJob(fresh("a"))).toBeNull();
      expect((await row("a")).status).toBe("succeeded");
    });

    it("accepts another key, and the same key again once its holder finished", async () => {
      await store().createJob(fresh("a"));
      expect(await store().createJob(fresh("b"))).not.toBeNull();
      expect(await store().finishJob(id("a"), { status: "succeeded" }, ["running"])).toBe(true);
      expect(await store().createJob(fresh("a", { id: id("a2") }))).not.toBeNull();
    });

    it("gives exactly one of several simultaneous starts the key", async () => {
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((i) => store().createJob(fresh("race", { id: id(`race-${i}`) }))),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await table().ids(PROJECTS)).toHaveLength(1);
    });
  });

  describe("reads are scoped to the project", () => {
    it("finds a job only through its own project", async () => {
      await plant("a");
      expect(await store().findJob(PA, id("a"))).toMatchObject({ id: id("a") });
      expect(await store().findJob(PB, id("a"))).toBeNull();
      expect(await store().findJob(PA, id("nope"))).toBeNull();
    });

    it("lists the project's live jobs — saving ones included — oldest first", async () => {
      await plant("second", { startedAt: ago(1_000) });
      await plant("first", { startedAt: ago(3_000), status: "cancelling" });
      await plant("third", { startedAt: ago(500), status: "saving" });
      await plant("done", { status: "succeeded", finishedAt: ago(10) });
      await plant("other", { projectId: PB });
      expect((await store().listLiveJobs(PA)).map((r) => r.id)).toEqual(
        ["first", "second", "third"].map(id),
      );
    });
  });

  describe("beatJob — only a live row can be refreshed", () => {
    it.each(["running", "cancelling", "saving"])(
      "refreshes a %s row and reports its status",
      async (status) => {
        await plant("a", { status, heartbeatAt: ago(60_000) });
        expect(await store().beatJob(id("a"))).toBe(status);
        expect(realNow() - (await row("a")).heartbeatAt.getTime()).toBeLessThan(30_000);
      },
    );

    it.each(["succeeded", "failed", "cancelled"])(
      "answers null for a %s row and leaves its heartbeat alone",
      async (status) => {
        const planted = await plant("a", { status, heartbeatAt: ago(60_000), finishedAt: ago(1) });
        expect(await store().beatJob(id("a"))).toBeNull();
        expect((await row("a")).heartbeatAt.getTime()).toBe(planted.heartbeatAt.getTime());
      },
    );

    it("answers null for a row that does not exist", async () => {
      expect(await store().beatJob(id("nope"))).toBeNull();
    });
  });

  describe("setJobPhase", () => {
    it("records the phase of a live job and leaves a finished job's as it ended", async () => {
      await plant("live");
      await plant("done", { status: "succeeded", phase: "Saving", finishedAt: ago(1) });
      await store().setJobPhase(id("live"), "Generating plan.md (1 of 5)");
      await store().setJobPhase(id("done"), "too late");
      expect((await row("live")).phase).toBe("Generating plan.md (1 of 5)");
      expect((await row("done")).phase).toBe("Saving");
    });
  });

  describe("beginSaving — the commit point", () => {
    it("moves a running row that still holds its key to saving, with a fresh heartbeat", async () => {
      const planted = await plant("a", { heartbeatAt: ago(60_000) });
      expect(await store().beginSaving(id("a"), planted.activeKey!)).toBe(true);
      const after = await row("a");
      expect(after.status).toBe("saving");
      expect(after.activeKey).toBe(planted.activeKey);
      expect(realNow() - after.heartbeatAt.getTime()).toBeLessThan(30_000);
    });

    it.each(["cancelling", "saving", "succeeded", "failed", "cancelled"])(
      "refuses a row that is %s, and changes nothing",
      async (status) => {
        const planted = await plant("a", { status, activeKey: key("held") });
        expect(await store().beginSaving(id("a"), key("held"))).toBe(false);
        expect(await row("a")).toMatchObject({
          status,
          heartbeatAt: planted.heartbeatAt,
          activeKey: key("held"),
        });
      },
    );

    it("refuses a running row whose key is no longer the job's", async () => {
      await plant("a", { activeKey: key("somebody-elses") });
      expect(await store().beginSaving(id("a"), key("mine"))).toBe(false);
      expect((await row("a")).status).toBe("running");
    });

    it("refuses a row whose key was released (a row failed by another replica)", async () => {
      await plant("a", { status: "failed", activeKey: null, finishedAt: ago(1) });
      expect(await store().beginSaving(id("a"), key("a"))).toBe(false);
      expect((await row("a")).status).toBe("failed");
    });

    it("refuses another job's id", async () => {
      const planted = await plant("a");
      expect(await store().beginSaving(id("b"), planted.activeKey!)).toBe(false);
      expect((await row("a")).status).toBe("running");
    });
  });

  describe("confirmSaving — every later write re-checks the row", () => {
    it("confirms a saving row that still holds its key, and refreshes its heartbeat", async () => {
      await plant("a", { status: "saving", activeKey: key("k"), heartbeatAt: ago(60_000) });
      expect(await store().confirmSaving(id("a"), key("k"))).toBe(true);
      expect(realNow() - (await row("a")).heartbeatAt.getTime()).toBeLessThan(30_000);
    });

    it.each(["running", "cancelling", "failed", "succeeded"])(
      "refuses a row that is %s",
      async (status) => {
        const planted = await plant("a", { status, activeKey: key("k") });
        expect(await store().confirmSaving(id("a"), key("k"))).toBe(false);
        expect((await row("a")).heartbeatAt.getTime()).toBe(planted.heartbeatAt.getTime());
      },
    );

    it("refuses a saving row under another key", async () => {
      await plant("a", { status: "saving", activeKey: key("k") });
      expect(await store().confirmSaving(id("a"), key("other"))).toBe(false);
    });

    it("refuses a swept job whose key a SUCCESSOR now holds, saving: the row is not its own", async () => {
      // X was swept mid-save; Y took the feature and is itself saving. The key
      // and the status both match Y's row — only the id says it is not X's.
      await plant("x", { status: "failed", activeKey: null, finishedAt: ago(1) });
      const successor = await plant("y", {
        status: "saving",
        activeKey: key("k"),
        heartbeatAt: ago(30_000),
      });
      expect(await store().confirmSaving(id("x"), key("k"))).toBe(false);
      // …and X's check did not refresh Y's heartbeat either.
      expect((await row("y")).heartbeatAt.getTime()).toBe(successor.heartbeatAt.getTime());
      expect(await store().confirmSaving(id("y"), key("k"))).toBe(true);
    });
  });

  describe("markJobCancelling", () => {
    it("moves a running row of the project to cancelling", async () => {
      await plant("a");
      expect(await store().markJobCancelling(PA, id("a"))).toBe(true);
      expect((await row("a")).status).toBe("cancelling");
    });

    it.each(["cancelling", "saving", "succeeded", "failed", "cancelled"])(
      "refuses a row that is %s",
      async (status) => {
        await plant("a", { status });
        expect(await store().markJobCancelling(PA, id("a"))).toBe(false);
        expect((await row("a")).status).toBe(status);
      },
    );

    it("cannot be aimed at another project's job", async () => {
      await plant("a");
      expect(await store().markJobCancelling(PB, id("a"))).toBe(false);
      expect((await row("a")).status).toBe("running");
    });
  });

  describe("finishJob — only from the statuses the caller names", () => {
    it("writes the outcome, releases the key and stamps the finish time", async () => {
      await plant("a", { status: "saving" });
      expect(
        await store().finishJob(id("a"), { status: "succeeded", result: '{"ok":true}' }, [
          "running",
          "saving",
        ]),
      ).toBe(true);
      const after = await row("a");
      expect(after).toMatchObject({
        status: "succeeded",
        activeKey: null,
        result: '{"ok":true}',
        error: null,
      });
      expect(realNow() - after.finishedAt!.getTime()).toBeLessThan(30_000);
    });

    it("refuses a row in a status the caller did not name, and changes nothing", async () => {
      const planted = await plant("a", { status: "cancelling" });
      expect(
        await store().finishJob(id("a"), { status: "succeeded", result: "{}" }, [
          "running",
          "saving",
        ]),
      ).toBe(false);
      expect(await row("a")).toMatchObject({
        status: "cancelling",
        activeKey: planted.activeKey,
        result: null,
        finishedAt: null,
      });
    });

    it.each(["succeeded", "failed", "cancelled"])(
      "never overwrites a row that is already %s",
      async (status) => {
        await plant("a", { status, result: "KEPT", error: "KEPT", finishedAt: ago(5_000) });
        for (const from of [["running", "saving"], ["cancelling"], ["running"]]) {
          expect(await store().finishJob(id("a"), { status: "failed", error: "LATE" }, from)).toBe(
            false,
          );
        }
        expect(await row("a")).toMatchObject({ status, result: "KEPT", error: "KEPT" });
      },
    );

    it("closes a cancelling row as cancelled", async () => {
      await plant("a", { status: "cancelling" });
      expect(await store().finishJob(id("a"), { status: "cancelled" }, ["cancelling"])).toBe(true);
      expect(await row("a")).toMatchObject({ status: "cancelled", activeKey: null, error: null });
    });

    it("answers false for a row that does not exist", async () => {
      expect(await store().finishJob(id("nope"), { status: "failed" }, ["running"])).toBe(false);
    });
  });

  describe("failStaleJobs — one statement, judged on the database's clock", () => {
    it("fails a running row whose heartbeat stopped, as interrupted before saving", async () => {
      await plant("a", { heartbeatAt: ago(STALE_MS + 30_000), result: "stale-result" });
      const swept = await store().failStaleJobs({}, STALE_MS, OUTCOMES);
      expect(swept).toEqual([{ id: id("a"), projectId: PA, status: "failed" }]);
      const after = await row("a");
      expect(after).toMatchObject({
        status: "failed",
        activeKey: null,
        result: null,
        error: OUTCOMES.interruptedError,
      });
      expect(realNow() - after.finishedAt!.getTime()).toBeLessThan(30_000);
    });

    it("fails a saving row as interrupted WHILE saving", async () => {
      await plant("a", { status: "saving", heartbeatAt: ago(STALE_MS + 30_000) });
      expect(await store().failStaleJobs({}, STALE_MS, OUTCOMES)).toEqual([
        { id: id("a"), projectId: PA, status: "failed" },
      ]);
      expect(await row("a")).toMatchObject({
        status: "failed",
        activeKey: null,
        error: OUTCOMES.interruptedWhileSavingError,
      });
    });

    it("closes a dead cancelling row as cancelled, with no error", async () => {
      await plant("a", { status: "cancelling", heartbeatAt: ago(STALE_MS + 30_000) });
      expect(await store().failStaleJobs({}, STALE_MS, OUTCOMES)).toEqual([
        { id: id("a"), projectId: PA, status: "cancelled" },
      ]);
      expect(await row("a")).toMatchObject({ status: "cancelled", activeKey: null, error: null });
    });

    it.each(["running", "cancelling", "saving"])(
      "leaves a %s row alone while its heartbeat is inside the threshold",
      async (status) => {
        const planted = await plant("a", { status, heartbeatAt: ago(STALE_MS - 45_000) });
        expect(await store().failStaleJobs({}, STALE_MS, OUTCOMES)).toEqual([]);
        expect(await row("a")).toMatchObject({ status, activeKey: planted.activeKey });
      },
    );

    // A finished job keeps the last heartbeat it ever wrote, so a day later it
    // is "stale" by any measure. It must still read as what it was.
    it.each([
      ["succeeded", '{"artifact":"kept"}', null],
      ["failed", null, '{"code":"SPEC_KIT_EMPTY_OUTPUT"}'],
      ["cancelled", null, null],
    ])("never touches a %s row, however old its heartbeat", async (status, result, error) => {
      const finishedAt = ago(3_600_000);
      await plant("a", { status, result, error, finishedAt, heartbeatAt: ago(3_700_000) });

      for (const scope of [{}, { id: id("a") }, { projectId: PA }]) {
        expect(await store().failStaleJobs(scope, STALE_MS, OUTCOMES)).toEqual([]);
      }
      const after = await row("a");
      expect(after).toMatchObject({ status, result, error });
      expect(after.finishedAt?.getTime()).toBe(finishedAt.getTime());
    });

    it("looks only at the rows in its scope", async () => {
      const old = { heartbeatAt: ago(STALE_MS + 30_000) };
      await plant("mine", { ...old, activeKey: key("mine") });
      await plant("same-project", old);
      await plant("other-project", { ...old, projectId: PB });

      expect(await store().failStaleJobs({ id: id("nope") }, STALE_MS, OUTCOMES)).toEqual([]);
      expect(
        await store().failStaleJobs({ id: id("mine"), projectId: PB }, STALE_MS, OUTCOMES),
      ).toEqual([]);
      expect(await store().failStaleJobs({ activeKey: key("nope") }, STALE_MS, OUTCOMES)).toEqual(
        [],
      );
      expect(
        (await store().failStaleJobs({ activeKey: key("mine") }, STALE_MS, OUTCOMES)).map(
          (s) => s.id,
        ),
      ).toEqual([id("mine")]);
      expect(
        (await store().failStaleJobs({ projectId: PB }, STALE_MS, OUTCOMES)).map((s) => s.id),
      ).toEqual([id("other-project")]);
      expect((await row("same-project")).status).toBe("running");
      expect(
        (await store().failStaleJobs({ id: id("same-project") }, STALE_MS, OUTCOMES)).map(
          (s) => s.id,
        ),
      ).toEqual([id("same-project")]);
    });

    it("judges staleness on the DATABASE's clock, whatever this process's clock says", async () => {
      // A job the database stamped just now…
      await store().createJob(fresh("live"));
      // …read by a replica whose clock runs an hour FAST: still not stale.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(realNow() + 3_600_000));
      expect(await store().failStaleJobs({}, STALE_MS, OUTCOMES)).toEqual([]);
      expect((await row("live")).status).toBe("running");

      // …and refreshed by an owner whose clock runs an hour SLOW: still not stale.
      vi.setSystemTime(new Date(realNow() - 3_600_000));
      expect(await store().beatJob(id("live"))).toBe("running");
      vi.useRealTimers();
      expect(await store().failStaleJobs({}, STALE_MS, OUTCOMES)).toEqual([]);
      expect(realNow() - (await row("live")).heartbeatAt.getTime()).toBeLessThan(30_000);
    });

    it("stamps a new job, a commit and a finish with the database's time, not this process's", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(realNow() + 7_200_000));
      const created = await store().createJob(fresh("a"));
      await store().beginSaving(id("a"), key("a"));
      const saving = await row("a");
      await store().finishJob(id("a"), { status: "succeeded" }, ["saving"]);
      const finished = await row("a");
      vi.useRealTimers();

      for (const stamp of [
        created!.heartbeatAt,
        created!.startedAt,
        saving.heartbeatAt,
        finished.finishedAt!,
      ]) {
        expect(Math.abs(realNow() - stamp.getTime())).toBeLessThan(60_000);
      }
    });
  });

  describe("every race has exactly one winner", () => {
    const ROUNDS = 12;

    it("cancel versus save", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const planted = await plant(`r${i}`);
        const [cancelled, saving] = await Promise.all([
          store().markJobCancelling(PA, planted.id),
          store().beginSaving(planted.id, planted.activeKey!),
        ]);
        expect([cancelled, saving].filter(Boolean)).toHaveLength(1);
        expect((await row(`r${i}`)).status).toBe(cancelled ? "cancelling" : "saving");
      }
    });

    it("time limit versus save", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const planted = await plant(`r${i}`);
        const [timedOut, saving] = await Promise.all([
          store().finishJob(planted.id, { status: "failed", error: "TIMEOUT" }, ["running"]),
          store().beginSaving(planted.id, planted.activeKey!),
        ]);
        expect([timedOut, saving].filter(Boolean)).toHaveLength(1);
        expect(await row(`r${i}`)).toMatchObject(
          timedOut ? { status: "failed", error: "TIMEOUT", activeKey: null } : { status: "saving" },
        );
      }
    });

    it("the owner finishing versus a sweep", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const planted = await plant(`r${i}`, { heartbeatAt: ago(STALE_MS + 30_000) });
        const [finished, swept] = await Promise.all([
          store().finishJob(planted.id, { status: "succeeded", result: "OWNER" }, [
            "running",
            "saving",
          ]),
          store().failStaleJobs({ id: planted.id }, STALE_MS, OUTCOMES),
        ]);
        expect(Number(finished) + swept.length).toBe(1);
        expect(await row(`r${i}`)).toMatchObject(
          finished
            ? { status: "succeeded", result: "OWNER", error: null }
            : { status: "failed", result: null, error: OUTCOMES.interruptedError },
        );
      }
    });

    it("a save versus a sweep of the same stale row", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const planted = await plant(`r${i}`, { heartbeatAt: ago(STALE_MS + 30_000) });
        const [saving, swept] = await Promise.all([
          store().beginSaving(planted.id, planted.activeKey!),
          store().failStaleJobs({ id: planted.id }, STALE_MS, OUTCOMES),
        ]);
        expect(Number(saving) + swept.length).toBe(1);
        expect((await row(`r${i}`)).status).toBe(saving ? "saving" : "failed");
      }
    });

    it("two sweeps of one dead job", async () => {
      await plant("dead", { heartbeatAt: ago(STALE_MS + 30_000) });
      const sweeps = await Promise.all(
        [1, 2, 3].map(() => store().failStaleJobs({}, STALE_MS, OUTCOMES)),
      );
      expect(sweeps.flat()).toHaveLength(1);
    });
  });

  describe("pruneFinishedJobs", () => {
    const DAY = 24 * 60 * 60 * 1000;

    it("deletes jobs that finished before the retention, and only those", async () => {
      await plant("old", { status: "succeeded", finishedAt: ago(DAY + 60_000) });
      await plant("old-failed", { status: "failed", finishedAt: ago(DAY + 60_000) });
      await plant("recent", { status: "failed", finishedAt: ago(DAY - 60_000) });
      await plant("alive", { heartbeatAt: ago(1_000) });
      // A live row is never pruned, whatever it carries.
      await plant("saving", { status: "saving", finishedAt: ago(DAY * 3) });

      expect(await store().pruneFinishedJobs(DAY)).toBe(2);
      expect(await table().ids(PROJECTS)).toEqual(["alive", "recent", "saving"].map(id).sort());
    });
  });

  describe("discardJob", () => {
    it("removes a job that never started, and nothing that did", async () => {
      await plant("never-started");
      await plant("saving", { status: "saving" });
      await plant("done", { status: "succeeded", finishedAt: ago(1) });
      for (const name of ["never-started", "saving", "done", "nope"]) {
        await store().discardJob(id(name));
      }
      expect(await table().ids(PROJECTS)).toEqual(["done", "saving"].map(id).sort());
    });
  });
}
