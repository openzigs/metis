/**
 * Issue #1321 — online-eval results store.
 *
 * `eval-results/` is gitignored, but it is a shared operator artifact that gets
 * copied around and was committed in the past. The privacy acceptance criterion
 * ("no raw user content is written to eval artifacts") is therefore enforced in
 * code rather than by the ignore rule, so these tests attack the write path
 * directly.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OnlineEvalSample, OnlineEvalWindow } from "@metis/shared";
import {
  assertContentFree,
  isWindowFile,
  listWindowIds,
  loadAllWindows,
  OnlineEvalContentLeakError,
  readPending,
  readWindow,
  writePending,
  writeWindow,
} from "./store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "online-store-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const HASH = "a".repeat(64);

function sample(over: Partial<OnlineEvalSample> = {}): OnlineEvalSample {
  return {
    sampleId: "s-1",
    surface: "chat",
    observedAt: "2026-08-15T00:00:00.000Z",
    questionHash: HASH,
    answerHash: "b".repeat(64),
    questionChars: 12,
    answerChars: 40,
    contextCount: 2,
    contextChars: 300,
    redactionHits: 1,
    scores: {
      context_precision: 1,
      context_recall: 1,
      faithfulness: 0.8,
      answer_relevancy: 0.7,
    },
    tokensCharged: 300,
    ...over,
  };
}

function window(over: Partial<OnlineEvalWindow> = {}): OnlineEvalWindow {
  return {
    windowId: "online-2026-08-15T00-00-00-000Z",
    schemaVersion: 1,
    startedAt: "2026-08-15T00:00:00.000Z",
    completedAt: "2026-08-15T01:00:00.000Z",
    judge: "StubRagasJudge",
    judgeMeaningful: false,
    sampleCount: 1,
    meanScores: {
      context_precision: 1,
      context_recall: 1,
      faithfulness: 0.8,
      answer_relevancy: 0.7,
    },
    scored: { context_precision: 1, context_recall: 1, faithfulness: 1, answer_relevancy: 1 },
    unverifiable: {
      context_precision: 0,
      context_recall: 0,
      faithfulness: 0,
      answer_relevancy: 0,
    },
    trendedMetrics: ["faithfulness", "answer_relevancy"],
    drift: {
      metric: "faithfulness",
      previous: null,
      delta: null,
      thresholdPct: 0.05,
      alert: false,
      reason: "NO_PREVIOUS_WINDOW",
    },
    budget: { monthBucket: "2026-08", tokensUsed: 300, tokensCap: 250_000, calls: 1 },
    samples: [sample()],
    ...over,
  };
}

describe("writeWindow / readWindow round trip", () => {
  it("writes an envelope the read path can load back", async () => {
    const w = window();
    await writeWindow(dir, w);
    const back = await readWindow(dir, w.windowId);
    expect(back).toEqual(w);
  });

  it("rejects a windowId that could escape the results directory", async () => {
    await expect(writeWindow(dir, window({ windowId: "../escape" }))).rejects.toThrow(
      /unsafe online-eval windowId/,
    );

    // A real, readable, schema-valid envelope OUTSIDE the results dir. Without
    // the id guard `path.join(dir, "../outside.json")` resolves straight onto it,
    // so this is the assertion that actually exercises the traversal check —
    // a non-existent path would return null with or without the guard.
    const outside = path.join(dir, "..", `outside-${path.basename(dir)}.json`);
    await fs.writeFile(outside, JSON.stringify(window({ windowId: "outside" })), "utf8");
    try {
      expect(await readWindow(dir, `../outside-${path.basename(dir)}`)).toBeNull();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("refuses to overwrite the reserved state files", async () => {
    await expect(writeWindow(dir, window({ windowId: "budget" }))).rejects.toThrow(/unsafe/);
    await expect(writeWindow(dir, window({ windowId: "pending" }))).rejects.toThrow(/unsafe/);
  });

  it("returns null for a malformed envelope instead of throwing", async () => {
    await fs.writeFile(path.join(dir, "broken.json"), "{ not json", "utf8");
    expect(await readWindow(dir, "broken")).toBeNull();
    await fs.writeFile(path.join(dir, "wrong.json"), JSON.stringify({ hello: 1 }), "utf8");
    expect(await readWindow(dir, "wrong")).toBeNull();
  });
});

describe("privacy: no user content reaches eval-results/", () => {
  it("rejects an unknown field on a sample — the shape a content leak takes", async () => {
    const leaky = { ...sample(), questionText: "what is our customer's SSN?" };
    await expect(
      writeWindow(dir, window({ samples: [leaky as unknown as OnlineEvalSample] })),
    ).rejects.toThrow();
    // Nothing landed on disk.
    expect(await listWindowIds(dir)).toEqual([]);
  });

  it("rejects an unknown field on the window envelope itself", async () => {
    const leaky = { ...window(), transcript: "user: hello\nassistant: hi" };
    await expect(writeWindow(dir, leaky as unknown as OnlineEvalWindow)).rejects.toThrow();
  });

  it("assertContentFree flags a long free-text string in a non-allowlisted field", () => {
    expect(() => assertContentFree({ notes: "x".repeat(200) })).toThrow(OnlineEvalContentLeakError);
    expect(() => assertContentFree({ samples: [{ answer: "y".repeat(129) }] })).toThrow(
      /samples\[0\]\.answer/,
    );
  });

  it("allows the reason/judge fields only within their length bound", () => {
    expect(() => assertContentFree(window())).not.toThrow();
    expect(() => assertContentFree({ reason: "z".repeat(200) })).not.toThrow();
    expect(() => assertContentFree({ judge: "z".repeat(128) })).not.toThrow();
  });

  it("bounds the allowlisted free-text fields instead of waving them through", () => {
    // `reason: `drift on ${question}`` is the shape a future author would write.
    // An unbounded allowlist entry is a hole at exactly that field.
    expect(() => assertContentFree({ reason: "z".repeat(201) })).toThrow(
      OnlineEvalContentLeakError,
    );
    expect(() => assertContentFree({ judge: "z".repeat(129) })).toThrow(OnlineEvalContentLeakError);
    // …at any depth, which is how the allowlist matches.
    expect(() => assertContentFree({ drift: { reason: "z".repeat(5_000) } })).toThrow(
      /drift\.reason/,
    );
  });

  it("refuses to persist a window whose drift.reason exceeds the schema bound", async () => {
    const w = window();
    const leaky = { ...w, drift: { ...w.drift, reason: `drift on ${"q".repeat(300)}` } };
    await expect(writeWindow(dir, leaky as OnlineEvalWindow)).rejects.toThrow();
  });

  it("the persisted bytes contain no context, question or answer text", async () => {
    const w = window();
    await writeWindow(dir, w);
    const raw = await fs.readFile(path.join(dir, `${w.windowId}.json`), "utf8");
    expect(raw).not.toMatch(/question(Text|Body)/i);
    expect(Object.keys(JSON.parse(raw).samples[0]).sort()).toEqual(
      [
        "answerChars",
        "answerHash",
        "contextChars",
        "contextCount",
        "observedAt",
        "questionChars",
        "questionHash",
        "redactionHits",
        "sampleId",
        "scores",
        "surface",
        "tokensCharged",
      ].sort(),
    );
  });

  it("writePending refuses a sample carrying free text", async () => {
    const leaky = { ...sample(), rawAnswer: "the customer's card is 4111 1111 1111 1111" };
    await expect(writePending(dir, [leaky as unknown as OnlineEvalSample])).rejects.toThrow();
    expect(await readPending(dir)).toEqual([]);
  });
});

describe("listing and pending buffer", () => {
  it("excludes the budget and pending state files from the window listing", async () => {
    expect(isWindowFile("budget.json")).toBe(false);
    expect(isWindowFile("pending.json")).toBe(false);
    expect(isWindowFile("online-1.json")).toBe(true);
    expect(isWindowFile(".hidden.json")).toBe(false);

    await writeWindow(dir, window({ windowId: "online-1" }));
    await writePending(dir, [sample()]);
    await fs.writeFile(path.join(dir, "budget.json"), "{}", "utf8");
    expect(await listWindowIds(dir)).toEqual(["online-1"]);
  });

  it("returns [] for a directory that does not exist", async () => {
    expect(await listWindowIds(path.join(dir, "nope"))).toEqual([]);
    expect(await readPending(path.join(dir, "nope"))).toEqual([]);
  });

  it("sorts loaded windows newest-first", async () => {
    await writeWindow(
      dir,
      window({ windowId: "online-old", completedAt: "2026-08-01T00:00:00.000Z" }),
    );
    await writeWindow(
      dir,
      window({ windowId: "online-new", completedAt: "2026-08-20T00:00:00.000Z" }),
    );
    const all = await loadAllWindows(dir);
    expect(all.map((w) => w.windowId)).toEqual(["online-new", "online-old"]);
  });

  it("round-trips the pending buffer", async () => {
    await writePending(dir, [sample({ sampleId: "s-1" }), sample({ sampleId: "s-2" })]);
    expect((await readPending(dir)).map((s) => s.sampleId)).toEqual(["s-1", "s-2"]);
    await writePending(dir, []);
    expect(await readPending(dir)).toEqual([]);
  });
});
