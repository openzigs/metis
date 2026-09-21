import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCS_GEN_BENCHMARK_FIXTURE_ID,
  DOCS_GEN_BENCHMARK_FIXTURES,
  listDocsGenBenchmarkFixtureIds,
  resolveDocsGenBenchmarkFixture,
} from "./fixtures.js";

describe("docs-gen benchmark fixtures", () => {
  it("exports the pinned single-repo fixture as the default", () => {
    expect(DEFAULT_DOCS_GEN_BENCHMARK_FIXTURE_ID).toBe("docsgen-01-single-repo");
    expect(DOCS_GEN_BENCHMARK_FIXTURES[DEFAULT_DOCS_GEN_BENCHMARK_FIXTURE_ID]?.mode).toBe(
      "single-repo",
    );
  });

  it("lists fixture ids in stable sorted order", () => {
    expect(listDocsGenBenchmarkFixtureIds()).toEqual([
      "docsgen-01-single-repo",
      "docsgen-02-multi-repo",
    ]);
  });

  it("resolves both pinned fixtures", () => {
    expect(resolveDocsGenBenchmarkFixture("docsgen-01-single-repo").repositories).toHaveLength(1);
    expect(resolveDocsGenBenchmarkFixture("docsgen-02-multi-repo").repositories).toHaveLength(2);
  });

  it("rejects unknown fixture ids with the allowed list", () => {
    expect(() => resolveDocsGenBenchmarkFixture("docsgen-99-missing")).toThrow(
      /docsgen-01-single-repo, docsgen-02-multi-repo/,
    );
  });
});
