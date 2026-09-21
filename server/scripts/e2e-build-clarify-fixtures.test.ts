/**
 * Issue #253 — the fixture builder must fail loud when an expected fixture key
 * is missing after the build, instead of letting the generative-e2e replay
 * silently degrade to the offline stub.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureStore } from "../src/lib/ai/fixtures/fixture-store.js";
import { assertFixturesPresent } from "./e2e-build-clarify-fixtures.js";

let dir: string;
let store: FixtureStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-guard-"));
  store = new FixtureStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Write a minimal valid fixture file for `key`. */
async function seed(key: string): Promise<void> {
  const record = {
    version: 1,
    key,
    request: { promptPreview: "", messageCount: 1, options: {} },
    response: { content: "{}", usage: {}, model: "m", provider: "offline-stub", offline: false },
    recordedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, `${key}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

describe("assertFixturesPresent (#253)", () => {
  const expected = [
    { label: "questions", key: "k_questions" },
    { label: "resolution", key: "k_resolution" },
    { label: "specialist", key: "k_specialist" },
    { label: "synthesis", key: "k_synthesis" },
  ];

  it("resolves when all expected fixtures exist", async () => {
    for (const { key } of expected) await seed(key);
    await expect(assertFixturesPresent(store, expected)).resolves.toBeUndefined();
  });

  it("throws naming the missing key when one fixture is absent", async () => {
    for (const { key } of expected.slice(0, 3)) await seed(key);
    // synthesis fixture is missing → must fail loud.
    await expect(assertFixturesPresent(store, expected)).rejects.toThrow(
      /missing expected fixture/i,
    );
    await expect(assertFixturesPresent(store, expected)).rejects.toThrow(
      /synthesis \(k_synthesis\)/,
    );
  });

  it("names every missing key when several are absent", async () => {
    await seed("k_questions");
    let message = "";
    try {
      await assertFixturesPresent(store, expected);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("resolution (k_resolution)");
    expect(message).toContain("specialist (k_specialist)");
    expect(message).toContain("synthesis (k_synthesis)");
    expect(message).not.toContain("questions (k_questions)");
  });

  it("does not degrade silently — a renamed key (stale fixture) is reported", async () => {
    // Simulate a prompt change: the on-disk fixture has the OLD key, but the
    // builder now expects a NEW key. The guard must catch the drift.
    await seed("k_synthesis_OLD_HASH");
    await expect(
      assertFixturesPresent(store, [{ label: "synthesis", key: "k_synthesis_NEW_HASH" }]),
    ).rejects.toThrow(/synthesis \(k_synthesis_NEW_HASH\)/);
  });
});
