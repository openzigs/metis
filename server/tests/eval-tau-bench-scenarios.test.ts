/**
 * Epic #194 (C.2) — TAU-bench scenario loader tests.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { defaultCacheDir, loadScenarios, parseJsonl } from "../src/lib/eval/tau-bench/scenarios.js";

const sample = {
  scenarioId: "airline_001",
  prompt: "Can you cancel reservation R123?",
  tools: ["get_reservation", "cancel_reservation"],
  expectedToolCalls: [
    { name: "get_reservation", args: { id: "R123" } },
    { name: "cancel_reservation", args: { id: "R123" } },
  ],
  finalState: { reservationStatus: "cancelled" },
};

let tmp: string | null = null;

afterEach(async () => {
  if (tmp) {
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe("defaultCacheDir", () => {
  it("includes the metis tau-bench namespace", () => {
    expect(defaultCacheDir()).toContain(path.join(".metis", "eval-cache", "tau-bench"));
  });
});

describe("parseJsonl", () => {
  it("parses one scenario per line and skips blanks", () => {
    const raw = `${JSON.stringify(sample)}\n\n${JSON.stringify({
      ...sample,
      scenarioId: "x_2",
    })}\n`;
    const parsed = parseJsonl(raw);
    expect(parsed).toHaveLength(2);
  });

  it("throws on missing required fields", () => {
    expect(() => parseJsonl(JSON.stringify({ scenarioId: "broken" }))).toThrow(
      /missing required fields/,
    );
  });
});

describe("loadScenarios", () => {
  it("returns inMemory scenarios capped by limit", async () => {
    const all = await loadScenarios({
      inMemory: [sample, { ...sample, scenarioId: "x_2" }],
      limit: 1,
    });
    expect(all).toHaveLength(1);
  });

  it("reads from cacheDir manifest", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tau-corpus-"));
    await fs.writeFile(path.join(tmp, "scenarios.jsonl"), `${JSON.stringify(sample)}\n`, "utf8");
    const all = await loadScenarios({ cacheDir: tmp });
    expect(all).toHaveLength(1);
  });

  it("throws a helpful error when the manifest is missing", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tau-corpus-"));
    await expect(loadScenarios({ cacheDir: tmp })).rejects.toThrow(/manifest not found/);
  });
});
