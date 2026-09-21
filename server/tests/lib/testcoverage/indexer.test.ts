import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NormalisedTestCase } from "@metis/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TestCoverageIndexer,
  caseNamespace,
  caseText,
  stepNamespace,
  stepText,
} from "../../../src/lib/testcoverage/indexer.js";
import { LocalVectorStore } from "../../../src/lib/rag/vector-store.js";

vi.mock("../../../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({
    model: "test-model",
    dimension: 4,
    async embed(texts: string[]) {
      // deterministic toy embedder: char-code sum per dimension slot
      return {
        model: "test-model",
        dimension: 4,
        vectors: texts.map((t) => {
          const v = [0, 0, 0, 0];
          for (let i = 0; i < t.length; i += 1) v[i % 4] += t.charCodeAt(i) / 1000;
          return v;
        }),
      };
    },
    async warm() {},
  }),
}));

const tc: NormalisedTestCase = {
  title: "Login",
  preconditions: "Have an account",
  steps: [{ action: "Open app" }, { action: "Type creds", expected: "Form valid" }],
  expected: "Dashboard",
  priority: "medium",
  tags: ["auth"],
  source: "csv",
};

describe("testcoverage/indexer", () => {
  let root: string;
  let store: LocalVectorStore;
  let indexer: TestCoverageIndexer;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tc-idx-"));
    store = new LocalVectorStore({ root });
    indexer = new TestCoverageIndexer({ store });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("caseText composes title/preconditions/steps/expected", () => {
    const text = caseText(tc);
    expect(text).toContain("Login");
    expect(text).toContain("Preconditions: Have an account");
    expect(text).toContain("Type creds — Form valid");
    expect(text).toContain("Expected: Dashboard");
  });

  it("stepText joins action + expected", () => {
    expect(stepText("a", "b")).toBe("a → b");
    expect(stepText("a")).toBe("a");
  });

  it("namespaces are project-scoped + colon-separated", () => {
    expect(caseNamespace("p1")).toBe("tc:p1");
    expect(stepNamespace("p1")).toBe("tcs:p1");
  });

  it("indexes a case + emits step rows", async () => {
    const result = await indexer.index("proj", [{ docId: "d1", contentHash: "h1", case: tc }]);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(await store.count(caseNamespace("proj"))).toBe(1);
    expect(await store.count(stepNamespace("proj"))).toBe(tc.steps.length);
  });

  it("is idempotent on re-index with same contentHash", async () => {
    await indexer.index("proj", [{ docId: "d1", contentHash: "h1", case: tc }]);
    const second = await indexer.index("proj", [{ docId: "d1", contentHash: "h1", case: tc }]);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toEqual(["d1"]);
  });

  it("re-indexes when contentHash changes (replaces step rows)", async () => {
    await indexer.index("proj", [{ docId: "d1", contentHash: "h1", case: tc }]);
    const updated: NormalisedTestCase = {
      ...tc,
      steps: [{ action: "Only one step" }],
    };
    const result = await indexer.index("proj", [{ docId: "d1", contentHash: "h2", case: updated }]);
    expect(result.inserted).toBe(1);
    expect(await store.count(stepNamespace("proj"))).toBe(1);
  });

  it("remove deletes case + step rows for a doc", async () => {
    await indexer.index("proj", [{ docId: "d1", contentHash: "h1", case: tc }]);
    const removed = await indexer.remove("proj", "d1");
    expect(removed).toBeGreaterThan(0);
    expect(await store.count(caseNamespace("proj"))).toBe(0);
    expect(await store.count(stepNamespace("proj"))).toBe(0);
  });

  it("returns 0 inserted for an empty input batch", async () => {
    const result = await indexer.index("proj", []);
    expect(result).toEqual({ inserted: 0, skipped: [] });
  });

  it("searchCases returns inserted rows", async () => {
    await indexer.index("proj", [{ docId: "d1", contentHash: "h1", case: tc }]);
    const hits = await indexer.searchCases("proj", [0, 0, 0, 0], 5);
    expect(hits.length).toBeGreaterThan(0);
  });
});
