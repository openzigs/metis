/**
 * Epic #803 (Epic 09) — results store unit tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DomainEvalRunResult } from "@metis/shared";
import { defaultResultsDir, listRunIds, loadAllRuns, readRun, writeRun } from "./results-store.js";

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "domain-results-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeRun(runId: string, startedAt: string, f1 = 0.9): DomainEvalRunResult {
  return {
    runId,
    schemaVersion: 1,
    model: "offline-stub",
    startedAt,
    completedAt: startedAt,
    itemCount: 1,
    corpusPrecision: f1,
    corpusRecall: f1,
    corpusF1: f1,
    meanRougeL: 0.8,
    totalTokens: 10,
    totalCostCents: 0,
    commit: null,
    calibration: [],
    drift: {
      previousF1: null,
      deltaF1: null,
      thresholdPct: 0.05,
      alert: false,
      reason: "NO_BASELINE",
    },
    items: [],
  };
}

describe("defaultResultsDir", () => {
  it("resolves <cwd>/eval-results", () => {
    expect(defaultResultsDir("/repo")).toBe(path.resolve("/repo", "eval-results"));
  });
});

describe("writeRun / readRun roundtrip", () => {
  it("persists and reads back a run", async () => {
    const dir = await tmp();
    const run = makeRun("2026-01-01T00-00-00-000Z", "2026-01-01T00:00:00.000Z");
    const file = await writeRun(dir, run);
    expect(file.endsWith(`${run.runId}.json`)).toBe(true);
    const loaded = await readRun(dir, run.runId);
    expect(loaded?.runId).toBe(run.runId);
    expect(loaded?.corpusF1).toBeCloseTo(0.9, 5);
  });

  it("returns null for a missing run", async () => {
    const dir = await tmp();
    expect(await readRun(dir, "does-not-exist")).toBeNull();
  });

  it("rejects path-traversal run ids", async () => {
    const dir = await tmp();
    expect(await readRun(dir, "../secret")).toBeNull();
    expect(await readRun(dir, "a/b")).toBeNull();
  });

  it("returns null for a file that fails schema validation", async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, "garbage.json"), JSON.stringify({ runId: "garbage" }));
    expect(await readRun(dir, "garbage")).toBeNull();
  });
});

describe("listRunIds", () => {
  it("returns an empty array for a missing directory", async () => {
    expect(await listRunIds("/no/such/eval-results")).toEqual([]);
  });
  it("lists json run ids, ignoring dotfiles and non-json", async () => {
    const dir = await tmp();
    await writeRun(dir, makeRun("run-b", "2026-01-02T00:00:00.000Z"));
    await writeRun(dir, makeRun("run-a", "2026-01-01T00:00:00.000Z"));
    await fs.writeFile(path.join(dir, ".hidden.json"), "{}");
    await fs.writeFile(path.join(dir, "notes.txt"), "x");
    expect(await listRunIds(dir)).toEqual(["run-a", "run-b"]);
  });
});

describe("loadAllRuns", () => {
  it("returns valid runs newest-first by startedAt", async () => {
    const dir = await tmp();
    await writeRun(dir, makeRun("old", "2026-01-01T00:00:00.000Z"));
    await writeRun(dir, makeRun("new", "2026-02-01T00:00:00.000Z"));
    const runs = await loadAllRuns(dir);
    expect(runs.map((r) => r.runId)).toEqual(["new", "old"]);
  });
  it("skips invalid run files", async () => {
    const dir = await tmp();
    await writeRun(dir, makeRun("good", "2026-01-01T00:00:00.000Z"));
    await fs.writeFile(path.join(dir, "bad.json"), JSON.stringify({ nope: true }));
    const runs = await loadAllRuns(dir);
    expect(runs.map((r) => r.runId)).toEqual(["good"]);
  });
});
