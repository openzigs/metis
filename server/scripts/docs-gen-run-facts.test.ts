/**
 * #1329 — the offline replays read a stored run's Phase-1 facts back from
 * `docs_gen_fact_cache`. They used to select rows LAST USED in the half hour
 * before the version, which a later run that reused the rows broke: every row
 * of the Miniflux project was moved forward by the 2026-10-23 run, and both
 * replays reported no facts for the earlier versions.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moduleFactsFromRows, positiveNumberArg, selectRunFactRows } from "./docs-gen-run-facts.js";

let db: Database.Database;

function row(
  id: string,
  modulePath: string,
  createdAt: string,
  lastUsedAt: string,
  extra: { facts?: string; model?: string; projectId?: string } = {},
): void {
  db.prepare(
    `insert into docs_gen_fact_cache
       (id, projectId, cacheKey, modulePath, fileFingerprint, model, facts, formulasJson,
        minedRulesJson, topClassesJson, classCount, methodCount, createdAt, lastUsedAt)
     values (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 1, 2, ?, ?)`,
  ).run(
    id,
    extra.projectId ?? "p1",
    id,
    modulePath,
    `fp-${id}`,
    extra.model ?? "deepseek-flash",
    extra.facts ?? `PURPOSE\n${modulePath} facts from ${id}.`,
    createdAt,
    lastUsedAt,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`create table docs_gen_fact_cache (
    id text primary key, projectId text, cacheKey text, modulePath text, fileFingerprint text,
    model text, facts text, formulasJson text, minedRulesJson text, topClassesJson text,
    classCount integer, methodCount integer, createdAt datetime, lastUsedAt datetime)`);
});

afterEach(() => {
  db.close();
});

const PUBLISHED = "2026-10-22T09:22:22.479+00:00";
const query = { projectId: "p1", model: "deepseek-flash", publishedAt: PUBLISHED, windowMin: 30 };

describe("selectRunFactRows", () => {
  it("still finds the rows a run read after a later run has used them again", () => {
    // Read by the 10-22 run at 09:10, then by the 10-23 run.
    row("a", "internal/api", "2026-10-16T00:24:04.472+00:00", "2026-10-23T11:46:00.071+00:00");
    row("b", "internal/ui", "2026-10-16T00:25:00.000+00:00", "2026-10-23T11:46:00.071+00:00");
    expect(selectRunFactRows(db, query).map((r) => r.modulePath)).toEqual([
      "internal/api",
      "internal/ui",
    ]);
  });

  it("leaves out a row created after the version, and one last used before the run", () => {
    row("old", "internal/reader", "2026-10-16T00:37:00.000+00:00", "2026-10-21T11:15:16.994+00:00");
    row("now", "internal/reader", "2026-10-21T11:15:30.285+00:00", "2026-10-23T11:46:00.071+00:00");
    row("later", "internal/new", "2026-10-23T11:40:00.000+00:00", "2026-10-23T11:46:00.071+00:00");
    expect(selectRunFactRows(db, query).map((r) => String(r.facts))).toEqual([
      "PURPOSE\ninternal/reader facts from now.",
    ]);
  });

  it("reads only the run's project and model", () => {
    row("x", "internal/api", "2026-10-16T00:00:00.000+00:00", "2026-10-22T09:10:00.000+00:00", {
      model: "claude-sonnet-5-5",
    });
    row("y", "internal/api", "2026-10-16T00:00:00.000+00:00", "2026-10-22T09:10:00.000+00:00", {
      projectId: "p2",
    });
    expect(selectRunFactRows(db, query)).toEqual([]);
  });

  it("rejects a publication time that is not a timestamp", () => {
    expect(() => selectRunFactRows(db, { ...query, publishedAt: "yesterday" })).toThrow(
      /not a timestamp/,
    );
  });
});

describe("moduleFactsFromRows", () => {
  it("merges a module's chunks into one ModuleFacts, in row order", () => {
    row("c1", "internal/api", "2026-10-16T00:24:00.000+00:00", "2026-10-22T09:10:00.000+00:00", {
      facts: "PURPOSE\nFirst chunk.",
    });
    row("c2", "internal/api", "2026-10-16T00:25:00.000+00:00", "2026-10-22T09:10:00.000+00:00", {
      facts: "PURPOSE\nSecond chunk.",
    });
    const facts = moduleFactsFromRows(selectRunFactRows(db, query));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ modulePath: "internal/api", moduleName: "api" });
    expect(facts[0].facts).toContain("First chunk.");
    expect(facts[0].facts).toContain("Second chunk.");
  });
});

describe("positiveNumberArg", () => {
  it("returns the fallback when the argument is absent, and the value when it is valid", () => {
    expect(positiveNumberArg([], "rag-chunks", 29, { integer: true })).toBe(29);
    expect(positiveNumberArg(["--rag-chunks", "12"], "rag-chunks", 29, { integer: true })).toBe(12);
    expect(positiveNumberArg(["--facts-window-min", "7.5"], "facts-window-min", 30)).toBe(7.5);
  });

  it("names the argument when its value is missing, not a number, zero or below, or not whole", () => {
    for (const argv of [
      ["--rag-chunks"],
      ["--rag-chunks", ""],
      ["--rag-chunks", "abc"],
      ["--rag-chunks", "0"],
      ["--rag-chunks", "-3"],
      ["--rag-chunks", "2.5"],
      ["--rag-chunks", "Infinity"],
    ]) {
      expect(() => positiveNumberArg(argv, "rag-chunks", 29, { integer: true })).toThrow(
        /--rag-chunks must be a whole number above 0/,
      );
    }
  });
});
