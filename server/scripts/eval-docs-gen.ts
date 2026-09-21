import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const RESULTS_DIR = path.join(REPO_ROOT, "eval-results", "docs-gen");

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

export interface DocsGenCliDeps {
  mkdtemp: typeof mkdtemp;
  mkdir: typeof mkdir;
  rm: typeof rm;
  writeFile: typeof writeFile;
  tmpdir: typeof os.tmpdir;
  importHarness: () => Promise<{
    assertThrowawayDatabase(databaseUrl: string, tmpRoot: string): void;
    pushSchema(databaseUrl: string): void;
    assertPrismaOwnsDatabase(databaseUrl: string): void;
  }>;
  importFixtures: () => Promise<{
    resolveDocsGenBenchmarkFixture(id: string): {
      id: string;
      mode: "single-repo" | "multi-repo";
      benchmarkReferenceCorpusId: string;
    };
  }>;
  importRunner: () => Promise<{
    runDocsGenBenchmark(input: {
      fixture: {
        id: string;
        mode: "single-repo" | "multi-repo";
        benchmarkReferenceCorpusId: string;
      };
      corpusDir: string;
      publicationDisposition: "local-only" | "pending-1308" | "public-approved";
      calibrationSource: string;
      fixtureDir?: string;
      liveModelRun?: boolean;
    }): Promise<unknown>;
  }>;
  log: (message: string) => void;
}

const DEFAULT_DEPS: DocsGenCliDeps = {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  tmpdir: os.tmpdir,
  importHarness: () => import("../src/lib/eval/doc-retrieval/wired-harness.js"),
  importFixtures: () => import("../src/lib/eval/docs-gen/fixtures.js"),
  importRunner: () => import("../src/lib/eval/docs-gen/runner.js"),
  log,
};

export interface ParsedDocsGenArgs {
  fixtureId: string;
  fixtureDir?: string;
  liveModelRun: boolean;
  publicationDisposition: "local-only" | "pending-1308" | "public-approved";
  typedSymbolEvidence?: {
    enabled: true;
    maxSymbols?: number;
    maxNeighbors?: number;
    maxSourceLines?: number;
  };
  outPath?: string;
}

export function parseDocsGenArgs(argv: readonly string[]): ParsedDocsGenArgs {
  const readValue = (flag: string): string | undefined => {
    const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const idx = argv.indexOf(flag);
    const next = idx >= 0 ? argv[idx + 1] : undefined;
    return next && !next.startsWith("--") ? next : undefined;
  };

  const fixtureId = readValue("--fixture") ?? "docsgen-01-single-repo";
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(fixtureId)) {
    throw new Error(`invalid --fixture ${JSON.stringify(fixtureId)}`);
  }

  const publicationDisposition =
    (readValue("--publication-disposition") as
      | ParsedDocsGenArgs["publicationDisposition"]
      | undefined) ?? "pending-1308";
  if (!["local-only", "pending-1308", "public-approved"].includes(publicationDisposition)) {
    throw new Error(
      `invalid --publication-disposition ${JSON.stringify(publicationDisposition)}. Expected local-only, pending-1308, or public-approved.`,
    );
  }

  const parsePositiveIntFlag = (flag: string): number | undefined => {
    const raw = readValue(flag);
    if (raw === undefined) return undefined;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`invalid typed symbol evidence budget for ${flag}: ${JSON.stringify(raw)}`);
    }
    return value;
  };

  const typedSymbolEnabled = argv.includes("--typed-symbol-evidence");
  const typedSymbolEvidence = typedSymbolEnabled
    ? {
        enabled: true as const,
        ...(parsePositiveIntFlag("--typed-symbol-max-symbols") !== undefined
          ? { maxSymbols: parsePositiveIntFlag("--typed-symbol-max-symbols") }
          : {}),
        ...(parsePositiveIntFlag("--typed-symbol-max-neighbors") !== undefined
          ? { maxNeighbors: parsePositiveIntFlag("--typed-symbol-max-neighbors") }
          : {}),
        ...(parsePositiveIntFlag("--typed-symbol-max-source-lines") !== undefined
          ? { maxSourceLines: parsePositiveIntFlag("--typed-symbol-max-source-lines") }
          : {}),
      }
    : undefined;

  return {
    fixtureId,
    fixtureDir: readValue("--fixture-dir"),
    liveModelRun: argv.includes("--live-model-run"),
    publicationDisposition,
    typedSymbolEvidence,
    outPath: readValue("--out"),
  };
}

export async function runDocsGenCli(
  argv: readonly string[],
  deps: DocsGenCliDeps = DEFAULT_DEPS,
): Promise<string> {
  const args = parseDocsGenArgs(argv);
  if (args.liveModelRun && process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS !== "1") {
    throw new Error(
      "live docs-gen benchmark runs require EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 so retrieval uses the real embedder",
    );
  }
  if (args.liveModelRun && process.env.EMBED_ALLOW_HASH_FALLBACK === "1") {
    throw new Error(
      "refusing to run live docs-gen benchmark with EMBED_ALLOW_HASH_FALLBACK=1 because hash vectors are non-semantic",
    );
  }

  const tmpRoot = await deps.mkdtemp(path.join(deps.tmpdir(), "eval1357-"));
  const databaseUrl = `file:${path.join(tmpRoot, "docs-gen-benchmark.db")}`;
  process.env.DATABASE_URL = databaseUrl;

  try {
    const harness = await deps.importHarness();
    const { resolveDocsGenBenchmarkFixture } = await deps.importFixtures();
    const { runDocsGenBenchmark } = await deps.importRunner();

    harness.assertThrowawayDatabase(databaseUrl, tmpRoot);
    harness.pushSchema(databaseUrl);
    harness.assertPrismaOwnsDatabase(databaseUrl);

    const fixture = resolveDocsGenBenchmarkFixture(args.fixtureId);
    const corpusDir = path.join(
      REPO_ROOT,
      "eval-data",
      "corpus",
      fixture.benchmarkReferenceCorpusId,
    );
    const result = await runDocsGenBenchmark({
      fixture,
      corpusDir,
      publicationDisposition: args.publicationDisposition,
      calibrationSource:
        "judge calibration not validated; reference answers are human-authored synthetic fixtures committed with issue #1357",
      typedSymbolEvidence: args.typedSymbolEvidence,
      ...(args.fixtureDir ? { fixtureDir: args.fixtureDir } : {}),
      ...(args.liveModelRun ? { liveModelRun: true } : {}),
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath =
      args.outPath ?? path.join(RESULTS_DIR, `docs-gen-benchmark-${fixture.id}-${stamp}.json`);
    await deps.mkdir(path.dirname(outPath), { recursive: true });
    await deps.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    deps.log(`fixture=${fixture.id} mode=${fixture.mode} live=${String(args.liveModelRun)}`);
    deps.log(`wrote ${outPath}`);
    deps.log(
      "judge calibration not validated: correctness metrics and A/B decisions remain exploratory, including live runs",
    );
    if (!args.liveModelRun) {
      deps.log(
        "deterministic run: token/cost metrics stay NOT REPORTED unless --live-model-run is supplied with a real provider",
      );
    }
    return outPath;
  } finally {
    await deps.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await runDocsGenCli(process.argv.slice(2));
}

const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].includes("eval-docs-gen");

if (invokedDirectly) {
  try {
    await main();
  } catch (err) {
    log(`eval:docs-gen failed: ${(err as Error).stack ?? String(err)}`);
    process.exitCode = 1;
  }
}
