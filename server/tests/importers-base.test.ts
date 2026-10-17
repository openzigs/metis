/**
 * Dedup + upsert engine — the idempotency guarantee for inbound importers.
 */
import { describe, expect, it } from "vitest";
import {
  defaultMap,
  normalizePriority,
  normalizeType,
  runImport,
  type RequirementStore,
  type RequirementUpsertInput,
} from "../src/lib/importers/base-importer.js";
import type { ExternalIssue, Importer, MappedRequirement } from "../src/lib/importers/types.js";
import type { SourcePending } from "../src/lib/importers/source-sync.js";

type Row = Omit<RequirementUpsertInput, "sourceFingerprint"> & {
  id: string;
  sourceFingerprint: string | null;
  sourcePending: SourcePending | null;
  version?: number;
  editedInMetis?: boolean;
};

/** In-memory requirement store keyed on (externalSource, externalId). */
function makeStore() {
  const rows = new Map<string, Row>();
  let n = 0;
  const syncWrites: string[] = [];
  const store: RequirementStore = {
    async findByExternal(_projectId, externalSource, externalId) {
      const hit = [...rows.values()].find(
        (r) => r.externalSource === externalSource && r.externalId === externalId,
      );
      if (!hit) return null;
      const { title, body, type, priority, labels } = hit;
      return {
        id: hit.id,
        local: { title, body, type, priority, labels },
        sourceFingerprint: hit.sourceFingerprint,
        sourcePending: hit.sourcePending,
        externalUrl: hit.externalUrl,
        importSourceId: hit.importSourceId,
        version: hit.version ?? 0,
        editedInMetis: hit.editedInMetis ?? false,
      };
    },
    async create(input) {
      n += 1;
      const id = `req_${n}`;
      rows.set(id, { ...input, id, sourcePending: null });
      return { id };
    },
    async update(id, input) {
      rows.set(id, { ...input, id, sourcePending: null });
      return { id };
    },
    async recordSourceSync(id, write) {
      syncWrites.push(id);
      const row = rows.get(id)!;
      rows.set(id, {
        ...row,
        ...(write.sourceFingerprint !== undefined
          ? { sourceFingerprint: write.sourceFingerprint }
          : {}),
        ...(write.sourcePending !== undefined ? { sourcePending: write.sourcePending } : {}),
        ...(write.externalUrl !== undefined ? { externalUrl: write.externalUrl } : {}),
        ...(write.importSourceId !== undefined ? { importSourceId: write.importSourceId } : {}),
      });
    },
    async setParent(childId, parentId) {
      const child = rows.get(childId);
      if (child) rows.set(childId, { ...child, body: `${child.body} parent:${parentId}` });
    },
  };
  return { store, rows, syncWrites };
}

/** Importer fixture backed by a fixed list of external issues. */
function fixtureImporter(issues: ExternalIssue[]): Importer<unknown> {
  return {
    kind: "github",
    async count() {
      return issues.length;
    },
    async *fetchAll() {
      for (const i of issues) yield i;
    },
    map(issue: ExternalIssue): MappedRequirement {
      return defaultMap(issue);
    },
  };
}

function issue(id: string, over: Partial<ExternalIssue> = {}): ExternalIssue {
  return {
    externalId: id,
    externalSource: "github",
    url: `https://gh/${id}`,
    title: `Issue ${id}`,
    body: "body",
    labels: [],
    ...over,
  };
}

const ctx = { projectId: "p1", analysisId: "a1", importSourceId: "s1" };

describe("normalizeType", () => {
  it("detects bug/epic/task hints and labels", () => {
    expect(normalizeType("Bug", [])).toBe("bug");
    expect(normalizeType(undefined, ["epic"])).toBe("epic");
    expect(normalizeType("Story", [])).toBe("feature");
    expect(normalizeType("chore", [])).toBe("task");
    expect(normalizeType("task", [])).toBe("task");
  });
});

describe("normalizePriority", () => {
  it("maps hints and priority labels", () => {
    expect(normalizePriority("Highest", [])).toBe("critical");
    expect(normalizePriority("urgent", [])).toBe("high");
    expect(normalizePriority("minor", [])).toBe("low");
    expect(normalizePriority(undefined, ["priority:high"])).toBe("high");
    expect(normalizePriority(undefined, [])).toBe("medium");
  });
});

describe("runImport idempotency", () => {
  it("creates one row per issue on first run", async () => {
    const { store, rows } = makeStore();
    const importer = fixtureImporter([issue("1"), issue("2"), issue("3")]);
    const result = await runImport({ importer, filter: {}, store, ...ctx });
    expect(result).toEqual({
      created: 3,
      updated: 0,
      keptLocal: 0,
      diverged: 0,
      skipped: 0,
      total: 3,
    });
    expect(rows.size).toBe(3);
  });

  it("re-running the same import creates zero duplicates", async () => {
    const { store, rows } = makeStore();
    const issues = [issue("1"), issue("2"), issue("3")];
    await runImport({ importer: fixtureImporter(issues), filter: {}, store, ...ctx });
    const second = await runImport({
      importer: fixtureImporter(issues),
      filter: {},
      store,
      ...ctx,
    });
    // #1220 — nothing changed on either side, so nothing is rewritten.
    expect(second).toEqual({
      created: 0,
      updated: 0,
      keptLocal: 0,
      diverged: 0,
      skipped: 0,
      total: 3,
    });
    expect(rows.size).toBe(3);
  });

  it("a re-run with 5 new issues creates exactly 5", async () => {
    const { store, rows } = makeStore();
    const first = [issue("1"), issue("2"), issue("3")];
    await runImport({ importer: fixtureImporter(first), filter: {}, store, ...ctx });
    const second = [...first, issue("4"), issue("5"), issue("6"), issue("7"), issue("8")];
    const r = await runImport({ importer: fixtureImporter(second), filter: {}, store, ...ctx });
    expect(r.created).toBe(5);
    expect(r.updated).toBe(0);
    expect(rows.size).toBe(8);
  });

  it("skips issues with an empty title", async () => {
    const { store } = makeStore();
    const r = await runImport({
      importer: fixtureImporter([issue("1", { title: "   " }), issue("2")]),
      filter: {},
      store,
      ...ctx,
    });
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(1);
  });

  it("resolves parent hierarchy via setParent", async () => {
    const { store, rows } = makeStore();
    await runImport({
      importer: fixtureImporter([issue("parent"), issue("child", { parentExternalId: "parent" })]),
      filter: {},
      store,
      ...ctx,
    });
    const child = [...rows.values()].find((r) => r.externalId === "child");
    expect(child?.body).toMatch(/parent:req_1/);
  });

  it("#1162 — an update the store skipped counts as skipped and is never parent-linked", async () => {
    const { store, rows } = makeStore();
    let issuesTitleSuffix = "";
    const run = () =>
      runImport({
        importer: fixtureImporter([
          issue("parent", { title: `Issue parent${issuesTitleSuffix}` }),
          issue("child", { parentExternalId: "parent", title: `Issue child${issuesTitleSuffix}` }),
        ]),
        filter: {},
        store,
        ...ctx,
      });
    // Recorded rather than written, so the first run leaves the child's text
    // as imported (the fixture's setParent edits the body, which #1220 would
    // read as a local edit).
    const setParentCalls: string[] = [];
    store.setParent = async (child) => {
      setParentCalls.push(child);
    };
    await run();
    setParentCalls.length = 0;
    // #1220 — an unchanged source no longer reaches `update`; change both.
    issuesTitleSuffix = " (renamed upstream)";
    const childId = [...rows.values()].find((r) => r.externalId === "child")!.id;
    store.update = async (id) => ({ id, skipped: id === childId });

    const second = await run();

    expect(second).toMatchObject({ created: 0, updated: 1, skipped: 1, total: 2 });
    expect(setParentCalls).not.toContain(childId);
  });

  it("links a child to a parent the run did not rewrite", async () => {
    const { store, rows } = makeStore();
    const issues = [issue("parent"), issue("child", { parentExternalId: "parent" })];
    await runImport({ importer: fixtureImporter(issues), filter: {}, store, ...ctx });
    const child = [...rows.values()].find((r) => r.externalId === "child")!;
    rows.set(child.id, { ...child, body: "reset" });
    // Child: edited locally, source unchanged — kept, and still linked.
    await runImport({ importer: fixtureImporter(issues), filter: {}, store, ...ctx });
    expect(rows.get(child.id)?.body).toMatch(/^reset parent:req_1/);
  });

  it("stops fetching when the signal is aborted", async () => {
    const { store, rows } = makeStore();
    const controller = new AbortController();
    controller.abort();
    const r = await runImport({
      importer: fixtureImporter([issue("1"), issue("2")]),
      filter: {},
      store,
      ...ctx,
      ctx: { signal: controller.signal },
    });
    expect(r.total).toBe(0);
    expect(rows.size).toBe(0);
  });
});

describe("runImport re-sync keeps analysts' edits (#1220)", () => {
  const NOW = new Date("2026-10-16T10:00:00.000Z");
  const run = (store: RequirementStore, issues: ExternalIssue[]) =>
    runImport({ importer: fixtureImporter(issues), filter: {}, store, ...ctx, now: () => NOW });

  it("source unchanged, local edited: keeps the edit and writes nothing", async () => {
    const { store, rows, syncWrites } = makeStore();
    await run(store, [issue("1")]);
    const row = [...rows.values()][0]!;
    rows.set(row.id, { ...row, body: "Refined by the analyst", priority: "high" });

    const r = await run(store, [issue("1")]);

    expect(r).toMatchObject({ updated: 0, keptLocal: 1, diverged: 0 });
    expect(rows.get(row.id)).toMatchObject({ body: "Refined by the analyst", priority: "high" });
    expect(syncWrites).toEqual([]);
  });

  it("source changed, local not edited: applies the source", async () => {
    const { store, rows } = makeStore();
    await run(store, [issue("1")]);
    const r = await run(store, [issue("1", { title: "Renamed upstream" })]);
    expect(r).toMatchObject({ updated: 1, keptLocal: 0, diverged: 0 });
    expect([...rows.values()][0]).toMatchObject({ title: "Renamed upstream", sourcePending: null });
  });

  it("both changed: keeps the local copy and records the source", async () => {
    const { store, rows } = makeStore();
    await run(store, [issue("1")]);
    const row = [...rows.values()][0]!;
    rows.set(row.id, { ...row, body: "Refined by the analyst" });

    const r = await run(store, [issue("1", { body: "Changed upstream" })]);

    expect(r).toMatchObject({ updated: 0, keptLocal: 0, diverged: 1 });
    const after = rows.get(row.id)!;
    expect(after.body).toBe("Refined by the analyst");
    expect(after.sourceFingerprint).toBe(row.sourceFingerprint);
    expect(after.sourcePending).toMatchObject({
      body: "Changed upstream",
      detectedAt: NOW.toISOString(),
    });
  });

  it("refreshes the source-owned link even when it keeps the analyst's content", async () => {
    const { store, rows, syncWrites } = makeStore();
    await run(store, [issue("1")]);
    const row = [...rows.values()][0]!;
    rows.set(row.id, { ...row, body: "Refined by the analyst" });

    // The issue moved (or its source was recreated): new URL, new source id.
    const r = await runImport({
      importer: fixtureImporter([issue("1", { url: "https://new-host/1" })]),
      filter: {},
      store,
      ...ctx,
      importSourceId: "s2",
      now: () => NOW,
    });

    expect(r).toMatchObject({ updated: 0, keptLocal: 1 });
    expect(rows.get(row.id)).toMatchObject({
      body: "Refined by the analyst",
      externalUrl: "https://new-host/1",
      importSourceId: "s2",
    });
    // An unchanged link is not rewritten.
    syncWrites.length = 0;
    await runImport({
      importer: fixtureImporter([issue("1", { url: "https://new-host/1" })]),
      filter: {},
      store,
      ...ctx,
      importSourceId: "s2",
      now: () => NOW,
    });
    expect(syncWrites).toEqual([]);
  });

  it("a row synced before the fingerprint: History decides, an edited one is never overwritten", async () => {
    const { store, rows } = makeStore();
    await run(store, [issue("1"), issue("2"), issue("3")]);
    const [same, edited, behind] = [...rows.values()];
    rows.set(same!.id, { ...same!, sourceFingerprint: null });
    rows.set(edited!.id, {
      ...edited!,
      sourceFingerprint: null,
      body: "Edited before #1220",
      editedInMetis: true,
    });
    // Never edited in METIS; its source simply moved on since the last sync.
    rows.set(behind!.id, { ...behind!, sourceFingerprint: null, body: "older source body" });

    const r = await run(store, [issue("1"), issue("2"), issue("3")]);

    expect(r).toMatchObject({ updated: 1, keptLocal: 0, diverged: 1 });
    expect(rows.get(same!.id)?.sourceFingerprint).toBe(same!.sourceFingerprint);
    expect(rows.get(edited!.id)).toMatchObject({
      body: "Edited before #1220",
      sourceFingerprint: null,
      sourcePending: expect.objectContaining({ body: "body", baselineUnknown: true }),
    });
    expect(rows.get(behind!.id)).toMatchObject({ body: "body", sourcePending: null });
  });

  it("a lost race is decided again in the same run, and a second loss is skipped", async () => {
    const { store, rows } = makeStore();
    await run(store, [issue("1"), issue("2")]);
    const [first, second] = [...rows.values()];
    const realUpdate = store.update.bind(store);
    let calls = 0;
    // #1 loses once to an analyst save, which is the row read again; #2 loses
    // every time.
    store.update = async (id, input, expectedVersion) => {
      calls += 1;
      if (id === first!.id && calls === 1) {
        rows.set(id, { ...rows.get(id)!, body: "Concurrent analyst edit", version: 1 });
        return { id, skipped: true, conflict: true };
      }
      if (id === second!.id) return { id, skipped: true, conflict: true };
      return realUpdate(id, input, expectedVersion);
    };

    const r = await run(store, [
      issue("1", { body: "upstream" }),
      issue("2", { body: "upstream" }),
    ]);

    expect(r).toMatchObject({ updated: 0, diverged: 1, skipped: 1 });
    expect(rows.get(first!.id)).toMatchObject({
      body: "Concurrent analyst edit",
      sourcePending: expect.objectContaining({ body: "upstream" }),
    });
    // The skipped row's fingerprint did not advance: the next sync decides it.
    expect(rows.get(second!.id)?.sourceFingerprint).toBe(second!.sourceFingerprint);
  });
});
