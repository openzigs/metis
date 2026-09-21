import { describe, expect, it, vi } from "vitest";
import { parseDocsGenArgs, runDocsGenCli } from "./eval-docs-gen.js";

describe("parseDocsGenArgs", () => {
  it("defaults to the pinned single-repo local harness", () => {
    expect(parseDocsGenArgs([])).toEqual({
      fixtureId: "docsgen-01-single-repo",
      liveModelRun: false,
      publicationDisposition: "pending-1308",
      typedSymbolEvidence: undefined,
      fixtureDir: undefined,
      outPath: undefined,
    });
  });

  it("accepts explicit fixture, replay fixture dir, live mode, and output path", () => {
    expect(
      parseDocsGenArgs([
        "--fixture",
        "docsgen-02-multi-repo",
        "--fixture-dir=/tmp/replay-fixtures",
        "--publication-disposition",
        "local-only",
        "--typed-symbol-evidence",
        "--typed-symbol-max-symbols=4",
        "--typed-symbol-max-neighbors",
        "2",
        "--typed-symbol-max-source-lines=40",
        "--out",
        "/tmp/run.json",
        "--live-model-run",
      ]),
    ).toEqual({
      fixtureId: "docsgen-02-multi-repo",
      fixtureDir: "/tmp/replay-fixtures",
      liveModelRun: true,
      publicationDisposition: "local-only",
      typedSymbolEvidence: {
        enabled: true,
        maxSymbols: 4,
        maxNeighbors: 2,
        maxSourceLines: 40,
      },
      outPath: "/tmp/run.json",
    });
  });

  it.each(["../secrets", "/etc/passwd", "docsgen;rm -rf /", "a b"])(
    "rejects invalid fixture id %s",
    (bad) => {
      expect(() => parseDocsGenArgs(["--fixture", bad])).toThrow(/invalid --fixture/);
    },
  );

  it("rejects an unsupported publication disposition", () => {
    expect(() => parseDocsGenArgs(["--publication-disposition", "public-now"])).toThrow(
      /invalid --publication-disposition/,
    );
  });

  it.each([
    ["--typed-symbol-max-symbols", "0"],
    ["--typed-symbol-max-neighbors", "-1"],
    ["--typed-symbol-max-source-lines", "0"],
  ])("rejects invalid typed symbol evidence budget %s=%s", (flag, value) => {
    expect(() => parseDocsGenArgs(["--typed-symbol-evidence", flag, value])).toThrow(
      /typed symbol/i,
    );
  });
});

describe("runDocsGenCli", () => {
  it("fails closed when a live run is requested without the real embedder", async () => {
    const previous = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS;
    delete process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS;
    try {
      await expect(runDocsGenCli(["--live-model-run"])).rejects.toThrow(
        /require EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1/,
      );
    } finally {
      if (previous !== undefined) process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS = previous;
    }
  });

  it("refuses a live run with the hash fallback enabled", async () => {
    const previousDownloads = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS;
    const previousFallback = process.env.EMBED_ALLOW_HASH_FALLBACK;
    process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS = "1";
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    try {
      await expect(runDocsGenCli(["--live-model-run"])).rejects.toThrow(
        /hash vectors are non-semantic/,
      );
    } finally {
      if (previousDownloads === undefined) delete process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS;
      else process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS = previousDownloads;
      if (previousFallback === undefined) delete process.env.EMBED_ALLOW_HASH_FALLBACK;
      else process.env.EMBED_ALLOW_HASH_FALLBACK = previousFallback;
    }
  });

  it("runs the local harness and writes the requested artifact path", async () => {
    const logLines: string[] = [];
    const mkdir = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const rm = vi.fn(async () => undefined);
    const runDocsGenBenchmark = vi.fn(async () => ({ ok: true }));
    const outPath = await runDocsGenCli(
      ["--fixture", "docsgen-02-multi-repo", "--out", "/tmp/docsgen-run.json"],
      {
        mkdtemp: async () => "/tmp/eval1357-test",
        mkdir,
        rm,
        writeFile,
        tmpdir: () => "/tmp",
        importHarness: async () => ({
          assertThrowawayDatabase: () => undefined,
          pushSchema: () => undefined,
          assertPrismaOwnsDatabase: () => undefined,
        }),
        importFixtures: async () => ({
          resolveDocsGenBenchmarkFixture: () => ({
            id: "docsgen-02-multi-repo",
            mode: "multi-repo",
            benchmarkReferenceCorpusId: "docsgen-02-multi-repo",
          }),
        }),
        importRunner: async () => ({
          runDocsGenBenchmark,
        }),
        log: (message) => logLines.push(message),
      },
    );

    expect(outPath).toBe("/tmp/docsgen-run.json");
    expect(runDocsGenBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationDisposition: "pending-1308",
        calibrationSource: expect.stringContaining("judge calibration not validated"),
        typedSymbolEvidence: undefined,
      }),
    );
    expect(mkdir).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(writeFile).toHaveBeenCalledWith("/tmp/docsgen-run.json", '{\n  "ok": true\n}\n', "utf8");
    expect(rm).toHaveBeenCalledWith("/tmp/eval1357-test", { recursive: true, force: true });
    expect(logLines).toContain("fixture=docsgen-02-multi-repo mode=multi-repo live=false");
    expect(
      logLines.some((line) =>
        line.includes("deterministic run: token/cost metrics stay NOT REPORTED"),
      ),
    ).toBe(true);
  });

  it("passes fixtureDir and liveModelRun through to the runner on explicit live runs", async () => {
    const runDocsGenBenchmark = vi.fn(async () => ({ ok: true }));
    const log = vi.fn();
    const previousDownloads = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS;
    const previousFallback = process.env.EMBED_ALLOW_HASH_FALLBACK;
    process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS = "1";
    delete process.env.EMBED_ALLOW_HASH_FALLBACK;
    try {
      await runDocsGenCli(
        [
          "--fixture=docsgen-01-single-repo",
          "--fixture-dir=/tmp/replay",
          "--publication-disposition=public-approved",
          "--live-model-run",
          "--typed-symbol-evidence",
          "--typed-symbol-max-symbols=8",
          "--out=/tmp/live.json",
        ],
        {
          mkdtemp: async () => "/tmp/eval1357-live",
          mkdir: async () => undefined,
          rm: async () => undefined,
          writeFile: async () => undefined,
          tmpdir: () => "/tmp",
          importHarness: async () => ({
            assertThrowawayDatabase: () => undefined,
            pushSchema: () => undefined,
            assertPrismaOwnsDatabase: () => undefined,
          }),
          importFixtures: async () => ({
            resolveDocsGenBenchmarkFixture: () => ({
              id: "docsgen-01-single-repo",
              mode: "single-repo",
              benchmarkReferenceCorpusId: "docsgen-01-single-repo",
            }),
          }),
          importRunner: async () => ({ runDocsGenBenchmark }),
          log,
        },
      );
    } finally {
      if (previousDownloads === undefined) delete process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS;
      else process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS = previousDownloads;
      if (previousFallback === undefined) delete process.env.EMBED_ALLOW_HASH_FALLBACK;
      else process.env.EMBED_ALLOW_HASH_FALLBACK = previousFallback;
    }

    expect(runDocsGenBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({
        fixtureDir: "/tmp/replay",
        liveModelRun: true,
        publicationDisposition: "public-approved",
        calibrationSource: expect.stringContaining("judge calibration not validated"),
        typedSymbolEvidence: { enabled: true, maxSymbols: 8 },
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/calibration not validated.*exploratory.*live runs/),
    );
  });
});
