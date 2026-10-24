/**
 * #1329 — the Phase-1 facts a stored docs-gen run was written from, read back
 * from `docs_gen_fact_cache` for the offline replays
 * (`docs-gen-prefix-report.ts`, `eval-brd-plan-replay.ts`). No model is called.
 *
 * A run reads one cache row per module chunk and moves its `lastUsedAt` to the
 * time it read it. Selecting rows by `lastUsedAt` inside a window before the
 * version (the first version of both replays) stops working as soon as a LATER
 * run reuses them: the paid run of 2026-10-23 moved every row of the Miniflux
 * project forward, and both replays reported "no Phase-1 facts in the window".
 * A row the run read was CREATED before the version was published and LAST
 * USED no earlier than the run's start, however many runs read it since; a row
 * a later run replaced has a later `createdAt`, and a row this run had already
 * replaced was last used before it.
 */
import type Database from "better-sqlite3";
import type { ModuleFacts } from "../src/lib/docs-gen/holistic-synthesizer.js";
import { mergePhase1ChunkFacts } from "../src/lib/docs-gen/phase1-chunking.js";

/** One `docs_gen_fact_cache` row, as the replays read it. */
export type FactRow = Record<string, string | number>;

export interface RunFactsQuery {
  projectId: string;
  model: string;
  /** When the version was published (`generated_document_versions.createdAt`). */
  publishedAt: string;
  /** How long before publishing the run may have started, in minutes. */
  windowMin: number;
}

/** The fact-cache rows the run read: created by its publication, used since its start. */
export function selectRunFactRows(db: Database.Database, q: RunFactsQuery): FactRow[] {
  const until = new Date(q.publishedAt);
  if (Number.isNaN(until.getTime())) throw new Error(`not a timestamp: ${q.publishedAt}`);
  const since = new Date(until.getTime() - q.windowMin * 60_000);
  return db
    .prepare(
      `select modulePath, facts, formulasJson, minedRulesJson, topClassesJson, classCount, methodCount
       from docs_gen_fact_cache
       where projectId = ? and model = ? and createdAt <= ? and lastUsedAt >= ?
       order by modulePath, createdAt`,
    )
    .all(q.projectId, q.model, until.toISOString(), since.toISOString()) as FactRow[];
}

/** Each module's facts, its chunks merged as Phase 1 merges them. */
export function moduleFactsFromRows(rows: readonly FactRow[]): ModuleFacts[] {
  const byPath = new Map<string, FactRow[]>();
  for (const r of rows) {
    const list = byPath.get(String(r.modulePath)) ?? [];
    list.push(r);
    byPath.set(String(r.modulePath), list);
  }
  return [...byPath].map(([modulePath, list]): ModuleFacts => ({
    modulePath,
    moduleName: modulePath.split("/").pop() || modulePath,
    classCount: Number(list[0].classCount),
    methodCount: Number(list[0].methodCount),
    facts: mergePhase1ChunkFacts(list.map((r) => String(r.facts))),
    formulas: list.flatMap((r) => JSON.parse(String(r.formulasJson)) as ModuleFacts["formulas"]),
    minedRules: list.flatMap(
      (r) => JSON.parse(String(r.minedRulesJson)) as NonNullable<ModuleFacts["minedRules"]>,
    ),
    topClasses: JSON.parse(String(list[0].topClassesJson)) as ModuleFacts["topClasses"],
  }));
}

/**
 * A numeric `--name value` argument, or `fallback` when it is absent. Anything
 * but a finite number above zero (an integer, when `integer` is set) is an
 * error naming the argument: `Number("abc")` is NaN, which every comparison
 * downstream treats as false, so a typo used to read as "no facts".
 */
export function positiveNumberArg(
  argv: readonly string[],
  name: string,
  fallback: number,
  opts: { integer?: boolean } = {},
): number {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const raw = argv[i + 1];
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (opts.integer && !Number.isInteger(value))) {
    throw new Error(
      `--${name} must be a ${opts.integer ? "whole number" : "number"} above 0, got ${JSON.stringify(raw ?? null)}`,
    );
  }
  return value;
}
