/**
 * Issue #1836 — the labelled requirement-pair set and the threshold sweep.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  chooseThreshold,
  EXTENDED_THRESHOLDS,
  loadRequirementPairs,
  PairFixtureError,
  pairRequirementText,
  renderCalibrationReport,
  runCalibration,
  scorePairs,
  sweep,
  THRESHOLDS,
  type RequirementPair,
  type ScoredPair,
} from "./calibration.js";
import { REQUIREMENT_SIMILARITY_THRESHOLDS } from "../../requirements/requirement-similarity-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "__fixtures__", "pairs.json");
const SERVER = path.resolve(here, "..", "..", "..", "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "metis-1836-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const writeFixture = (name: string, content: unknown): string => {
  const file = path.join(tmp, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};

const pair = (id: string, label: RequirementPair["label"], extra = {}): RequirementPair => ({
  id,
  domain: "d",
  label,
  a: { title: `${id} a`, body: "" },
  b: { title: `${id} b`, body: "" },
  ...extra,
});

describe("the committed pair set", () => {
  it("has >= 120 pairs over >= 3 domains with >= 30 hard negatives and every label", async () => {
    const pairs = await loadRequirementPairs(FIXTURE);
    expect(pairs.length).toBeGreaterThanOrEqual(120);
    expect(new Set(pairs.map((p) => p.domain)).size).toBeGreaterThanOrEqual(3);
    expect(pairs.filter((p) => p.hardNegative).length).toBeGreaterThanOrEqual(30);
    expect(new Set(pairs.map((p) => p.label))).toEqual(
      new Set(["duplicate", "overlap", "related", "unrelated"]),
    );
  });

  it("never pairs a requirement with itself", async () => {
    const pairs = await loadRequirementPairs(FIXTURE);
    for (const p of pairs) expect(pairRequirementText(p.a)).not.toBe(pairRequirementText(p.b));
  });
});

describe("loadRequirementPairs refuses a bad fixture", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["not JSON", "{ nope", /not valid JSON/],
    ["no pairs", { version: 1, pairs: [] }, /malformed at pairs/],
    [
      "a blank title",
      { version: 1, pairs: [{ ...pair("x", "duplicate"), a: { title: " ", body: "" } }] },
      /malformed at pairs\.0\.a\.title/,
    ],
    [
      "an unknown label",
      { version: 1, pairs: [{ ...pair("x", "duplicate"), label: "same" }] },
      /malformed at pairs\.0\.label/,
    ],
    [
      "a repeated id",
      { version: 1, pairs: [pair("x", "related"), pair("x", "unrelated")] },
      /appears twice/,
    ],
    [
      "a hard negative labelled duplicate",
      { version: 1, pairs: [pair("x", "duplicate", { hardNegative: true })] },
      /hard negative labelled duplicate/,
    ],
  ];
  it.each(cases)("%s", async (name, content, message) => {
    const file = writeFixture(`${name.replace(/\W+/g, "-")}.json`, content);
    await expect(loadRequirementPairs(file)).rejects.toThrow(message);
    await expect(loadRequirementPairs(file)).rejects.toBeInstanceOf(PairFixtureError);
  });

  it("a missing file", async () => {
    await expect(loadRequirementPairs(path.join(tmp, "absent.json"))).rejects.toThrow(
      /not readable/,
    );
  });
});

describe("the script", () => {
  it("exits non-zero on a missing or malformed fixture without loading the embedder", async () => {
    const run = promisify(execFile);
    for (const fixture of [path.join(tmp, "absent.json"), writeFixture("bad.json", "[]")]) {
      const err = (await run(
        process.execPath,
        ["--import", "tsx", "scripts/eval-req-similarity.ts", "--fixture", fixture],
        { cwd: SERVER },
      ).then(
        () => null,
        (e: unknown) => e,
      )) as { code?: number; stdout?: string; stderr?: string } | null;
      expect(err?.code).toBe(2);
      expect(`${err?.stdout}${err?.stderr}`).not.toMatch(/loading .* model/);
      expect(err?.stderr).toMatch(/pair fixture/);
    }
  }, 60_000);
});

const scoredPair = (
  label: ScoredPair["label"],
  score: number,
  hardNegative = false,
): ScoredPair => ({
  id: `${label}-${score}`,
  domain: "d",
  label,
  hardNegative,
  score,
});

describe("sweep and chooseThreshold", () => {
  const scored = [
    scoredPair("duplicate", 0.95),
    scoredPair("duplicate", 0.85),
    scoredPair("related", 0.9, true),
    scoredPair("unrelated", 0.4),
  ];

  it("counts score >= threshold as predicted positive", () => {
    const [row] = sweep(scored, new Set(["duplicate"]), [0.85]);
    expect(row).toEqual({
      threshold: 0.85,
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 0,
      precision: 2 / 3,
      recall: 1,
      f1: 0.8,
    });
  });

  it("reports precision as null when nothing scores that high", () => {
    const [row] = sweep(scored, new Set(["duplicate"]), [0.99]);
    expect(row).toMatchObject({ precision: null, recall: 0, f1: 0 });
  });

  it("picks the highest precision that keeps the recall, and none when no row does", () => {
    const rows = sweep(scored, new Set(["duplicate"]), [0.8, 0.91, 0.96]);
    // 0.80: p 2/3 r 1; 0.91: p 1 r 0.5; 0.96: nothing.
    expect(chooseThreshold(rows, 0.5)?.threshold).toBe(0.91);
    expect(chooseThreshold(rows, 0.6)?.threshold).toBe(0.8);
    expect(chooseThreshold(rows, 1.01)).toBeNull();
  });

  it("breaks a precision tie on the higher recall", () => {
    const rows = sweep(
      [scoredPair("duplicate", 0.9), scoredPair("duplicate", 0.8)],
      new Set(["duplicate"]),
      [0.85, 0.8],
    );
    expect(chooseThreshold(rows, 0)?.threshold).toBe(0.8);
  });

  it("sweeps 0.80 to 0.98 by 0.01, and the extended range from 0.50", () => {
    expect(THRESHOLDS[0]).toBe(0.8);
    expect(THRESHOLDS.at(-1)).toBe(0.98);
    expect(THRESHOLDS).toHaveLength(19);
    expect(EXTENDED_THRESHOLDS[0]).toBe(0.5);
    expect(EXTENDED_THRESHOLDS.at(-1)).toBe(0.98);
  });
});

/** Same text, same vector; the label decides how close a pair's texts are. */
const fakeEmbed = async (texts: string[]) => ({
  vectors: texts.map((t) => {
    const angle = t.startsWith("dup") ? 0.1 : t.startsWith("rel") ? 0.5 : 1.4;
    return t.endsWith(" a") ? [1, 0] : [Math.cos(angle), Math.sin(angle)];
  }),
  model: "fake",
});

describe("runCalibration", () => {
  it("embeds each distinct text once and scores each pair", async () => {
    const calls: string[][] = [];
    const pairs = [pair("dup1", "duplicate"), pair("dup1b", "duplicate")];
    pairs[1] = { ...pairs[1], a: pairs[0].a };
    const { scored, model } = await scorePairs(pairs, async (t) => {
      calls.push(t);
      return fakeEmbed(t);
    });
    expect(model).toBe("fake");
    expect(calls.flat()).toHaveLength(3);
    expect(scored[0].score).toBeCloseTo(Math.cos(0.1));
  });

  it("rejects an embedder that drops a text", async () => {
    await expect(
      scorePairs([pair("dup1", "duplicate")], async () => ({ vectors: [[1, 0]], model: "m" })),
    ).rejects.toThrow(/returned 1 vectors for 2 texts/);
  });

  it("reports every class, the hard negatives over the duplicate threshold, and renders", async () => {
    const pairs = [
      pair("dup1", "duplicate"),
      pair("dup2", "duplicate"),
      pair("rel1", "related", { hardNegative: true }),
      pair("unr1", "unrelated"),
    ];
    const report = await runCalibration(pairs, fakeEmbed);
    expect(report.classes.map((c) => c.name)).toEqual([
      "duplicate",
      "duplicate-or-overlap",
      "duplicate-or-overlap (extended)",
      "similar (extended)",
    ]);
    // Precision 1 and recall 1 from 0.88 (the related pair scores 0.878): ties go low.
    expect(report.classes[0].chosen?.threshold).toBe(0.88);
    expect(report.hardNegativesOverDuplicate).toEqual([]);
    expect(report.labelCounts).toEqual({ duplicate: 2, overlap: 0, related: 1, unrelated: 1 });
    const md = renderCalibrationReport(report);
    expect(md).toContain("Chosen: **0.88**");
    expect(md).toContain("1 hard negatives");
  });

  it("names the hard negatives that score as duplicates, and says when nothing qualifies", async () => {
    const pairs = [pair("rel1", "related", { hardNegative: true }), pair("unr1", "unrelated")];
    const report = await runCalibration(pairs, async (texts) => ({
      vectors: texts.map(() => [1, 0]),
      model: "flat",
    }));
    // No duplicates at all: no threshold keeps any recall.
    expect(report.classes[0].chosen).toBeNull();
    expect(renderCalibrationReport(report)).toContain("Chosen: **none**");

    const alike = await runCalibration(
      [pair("dup1", "duplicate"), pair("rel1", "related", { hardNegative: true })],
      async (texts) => ({ vectors: texts.map(() => [1, 0]), model: "flat" }),
    );
    expect(alike.classes[0].chosen).toMatchObject({ threshold: 0.8, precision: 0.5 });
    expect(alike.hardNegativesOverDuplicate).toEqual(["rel1"]);
    expect(renderCalibrationReport(alike)).toContain(
      "Hard negatives at or above the duplicate threshold: rel1.",
    );
  });
});

describe("the committed thresholds", () => {
  it("are ordered, and demand analyst confirmation exactly when duplicate precision < 0.8", () => {
    const t = REQUIREMENT_SIMILARITY_THRESHOLDS;
    expect(t.duplicate).toBeGreaterThanOrEqual(t.overlap);
    expect(t.overlap).toBeGreaterThan(t.related);
    expect(t.analystConfirmRequired).toBe(t.duplicatePrecision < 0.8);
  });
});
