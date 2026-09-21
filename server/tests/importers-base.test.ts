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

/** In-memory requirement store keyed on (externalSource, externalId). */
function makeStore() {
  const rows = new Map<string, RequirementUpsertInput & { id: string }>();
  let n = 0;
  const store: RequirementStore = {
    async findByExternal(_projectId, externalSource, externalId) {
      const hit = [...rows.values()].find(
        (r) => r.externalSource === externalSource && r.externalId === externalId,
      );
      return hit ? { id: hit.id } : null;
    },
    async create(input) {
      n += 1;
      const id = `req_${n}`;
      rows.set(id, { ...input, id });
      return { id };
    },
    async update(id, input) {
      rows.set(id, { ...input, id });
      return { id };
    },
    async setParent(childId, parentId) {
      const child = rows.get(childId);
      if (child) rows.set(childId, { ...child, body: `${child.body} parent:${parentId}` });
    },
  };
  return { store, rows };
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
    expect(result).toEqual({ created: 3, updated: 0, skipped: 0, total: 3 });
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
    expect(second).toEqual({ created: 0, updated: 3, skipped: 0, total: 3 });
    expect(rows.size).toBe(3);
  });

  it("a re-run with 5 new issues creates exactly 5", async () => {
    const { store, rows } = makeStore();
    const first = [issue("1"), issue("2"), issue("3")];
    await runImport({ importer: fixtureImporter(first), filter: {}, store, ...ctx });
    const second = [...first, issue("4"), issue("5"), issue("6"), issue("7"), issue("8")];
    const r = await runImport({ importer: fixtureImporter(second), filter: {}, store, ...ctx });
    expect(r.created).toBe(5);
    expect(r.updated).toBe(3);
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
